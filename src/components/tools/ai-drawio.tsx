import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DiagramDocument,
  DiagramExportRequest,
  DiagramUpdateResult,
} from '../../../electron/diagram-types'
import type { ToolProps } from './shared'
import {
  BRIDGE_PROTOCOL,
  classifyBridgeMessage,
  type BridgeMessage,
} from './ai-drawio-bridge'

// Bounded lifecycle timeouts (P0 fix). The previous implementation could
// remain stuck on the "正在启动 AI Draw.io…" splash forever if the document
// load hung (e.g. IPC glitch, missing diagram id). Each phase now has an
// explicit bounded timeout that transitions to a retryable error.
//
//   - START_TIMEOUT_MS: grace over the main process's 30s startAiDrawioServer
//     timeout. If the IPC has not returned by 35s, the renderer gives up and
//     surfaces a retryable error (defense-in-depth; the main process should
//     have returned an error result already).
//   - DOCUMENT_LOAD_TIMEOUT_MS: the getDiagram/createDiagram IPC must return
//     within 15s. A hang here previously left the splash visible even though
//     the local server was already serving HTTP 200 — the user saw "正在启动
//     AI Draw.io…" indefinitely. Now it flips to a retryable error.
//   - FRAME_READY_TIMEOUT_MS: after the iframe loads, the embedded Draw.io
//     bridge must post `raintool:diagram-ready` within 20s. If it doesn't, the
//     canvas is not usable and the user sees a retryable error (the iframe is
//     reloaded on retry).
const START_TIMEOUT_MS = 35_000
const DOCUMENT_LOAD_TIMEOUT_MS = 15_000
const FRAME_READY_TIMEOUT_MS = 20_000

type Phase =
  | { kind: 'starting' }
  | { kind: 'loading-document'; url: string }
  | { kind: 'ready'; url: string }
  | {
      kind: 'error'
      message: string
      details?: string
      /** Which retry path the button should trigger. */
      retry: 'start' | 'document' | 'frame'
    }

export default function AiDrawio({ diagramId, onDiagramId }: ToolProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
  const [document, setDocument] = useState<DiagramDocument | null>(null)
  const [frameState, setFrameState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [frameKey, setFrameKey] = useState(0)
  const [syncWarning, setSyncWarning] = useState<string | null>(null)
  const mounted = useRef(true)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const frameReadyRef = useRef(false)
  const frameOriginRef = useRef<string | null>(null)
  const documentRef = useRef<DiagramDocument | null>(null)
  const documentRequestRef = useRef<{
    diagramId?: string
    promise: Promise<DiagramDocument | null>
  } | null>(null)
  const pendingSaveRef = useRef<string | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  // The main process broadcasts every persisted update to all renderers. Keep
  // track of our own revision so that broadcast does not reload this canvas.
  const localSaveRevisionsRef = useRef<Map<string, Set<number>>>(new Map())
  const pendingExportsRef = useRef<Map<string, DiagramExportRequest>>(new Map())
  const onDiagramIdRef = useRef(onDiagramId)
  const persistXmlRef = useRef<(xml: string) => Promise<void>>(async () => {})
  // P0 fix: track whether the legacy migration has already run so a reloaded
  // iframe does not re-trigger it (idempotent guard, also enforced by the
  // classifier via legacyMigrationDone in the context).
  const legacyMigrationDoneRef = useRef<boolean>(
    typeof localStorage !== 'undefined' &&
      localStorage.getItem('raintool:legacy-diagrams-migrated-v1') === 'true',
  )

  useEffect(() => { onDiagramIdRef.current = onDiagramId }, [onDiagramId])

  const postToFrame = useCallback((message: Record<string, unknown>) => {
    const frameWindow = frameRef.current?.contentWindow
    const origin = frameOriginRef.current
    if (!frameWindow || !origin) return
    frameWindow.postMessage({ protocol: BRIDGE_PROTOCOL, ...message }, origin)
  }, [])

  const loadDocumentIntoFrame = useCallback((next: DiagramDocument) => {
    documentRef.current = next
    setDocument(next)
    onDiagramIdRef.current?.(next.id, next.title)
    postToFrame({
      type: 'raintool:diagram-load',
      diagramId: next.id,
      revision: next.revision,
      xml: next.xml,
    })
  }, [postToFrame])

  const persistXml = useCallback(async (xml: string) => {
    const current = documentRef.current
    if (!current || xml === current.xml) return
    const expectedLocalRevision = current.revision + 1
    const localRevisions = localSaveRevisionsRef.current.get(current.id) ?? new Set<number>()
    localRevisions.add(expectedLocalRevision)
    localSaveRevisionsRef.current.set(current.id, localRevisions)

    let result: DiagramUpdateResult
    try {
      result = await window.raintool.updateDiagram({
        id: current.id,
        xml,
        expectedRevision: current.revision,
      })
    } catch (error) {
      localRevisions.delete(expectedLocalRevision)
      if (localRevisions.size === 0) localSaveRevisionsRef.current.delete(current.id)
      throw error
    }
    if (!mounted.current) return
    if (result.status === 'conflict') {
      localRevisions.delete(expectedLocalRevision)
      if (localRevisions.size === 0) localSaveRevisionsRef.current.delete(current.id)
      setSyncWarning('图纸同时被外部工具更新，已载入最新版本；请检查后继续编辑。')
      loadDocumentIntoFrame(result.document)
      return
    }
    setSyncWarning(null)
    documentRef.current = result.document
    setDocument(result.document)
  }, [loadDocumentIntoFrame])

  const queueSave = useCallback((xml: string) => {
    pendingSaveRef.current = xml
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      const pending = pendingSaveRef.current
      pendingSaveRef.current = null
      if (pending) void persistXml(pending)
    }, 600)
  }, [persistXml])

  useEffect(() => { persistXmlRef.current = persistXml }, [persistXml])

  const start = useCallback(async () => {
    setPhase({ kind: 'starting' })
    setFrameState('loading')
    try {
      const result = await window.raintool.startAiDrawio()
      if (!mounted.current) return
      if (result.status === 'ready') {
        frameOriginRef.current = new URL(result.url).origin
        // P0 修复：文档加载 effect 在挂载时就会发起（phase='starting' 时不等
        // start() 返回）。如果文档已经在 start() 等待期间加载完成并写入
        // documentRef，此处必须直接进入 ready —— 否则 phase 会停在
        // loading-document（文档 effect 的 .then 不会再跑，因为依赖未变），
        // 直到 15s 超时才报错，表现就是「一直启动中/加载中」。文档 effect
        // 保证 documentRef.current 与当前 diagramId 一致，所以这里只要
        // documentRef 有值即可直接就绪，iframe 渲染后由 FRAME_READY_TIMEOUT
        // 兜底桥接就绪。
        const current = documentRef.current
        if (current) {
          setPhase({ kind: 'ready', url: result.url })
        } else {
          setPhase({ kind: 'loading-document', url: result.url })
        }
      } else {
        frameOriginRef.current = null
        setPhase({
          kind: 'error',
          message: result.message,
          details: result.details,
          retry: 'start',
        })
      }
    } catch (error) {
      if (!mounted.current) return
      setPhase({
        kind: 'error',
        message: '无法请求启动 AI Draw.io 服务。',
        details: error instanceof Error ? error.message : String(error),
        retry: 'start',
      })
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void start()
    return () => {
      mounted.current = false
      frameReadyRef.current = false
      const current = documentRef.current
      if (current) window.raintool.setDiagramEditorReady(current.id, false)
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      const pending = pendingSaveRef.current
      if (pending) void persistXmlRef.current(pending)
    }
  }, [start])

  // P0 fix: bounded timeout on the `starting` phase. If startAiDrawio has not
  // returned by START_TIMEOUT_MS (35s — grace over the main process's 30s
  // internal timeout), surface a retryable error instead of leaving the splash
  // visible forever.
  useEffect(() => {
    if (phase.kind !== 'starting') return
    const timer = window.setTimeout(() => {
      if (!mounted.current) return
      setPhase({
        kind: 'error',
        message: 'AI Draw.io 服务启动超时。',
        details: `渲染层在 ${START_TIMEOUT_MS / 1000}s 内未收到主进程响应。主进程可能仍在尝试启动本地服务，可重试或检查 127.0.0.1:13370 是否被占用。`,
        retry: 'start',
      })
    }, START_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [phase.kind])

  useEffect(() => {
    const current = documentRef.current
    if (current && (!diagramId || current.id === diagramId)) return

    let cancelled = false
    if (!documentRequestRef.current || documentRequestRef.current.diagramId !== diagramId) {
      documentRequestRef.current = {
        diagramId,
        promise: diagramId
          ? window.raintool.getDiagram(diagramId)
          : window.raintool.createDiagram({ title: '未命名图纸', source: 'raintool' }),
      }
    }
    void documentRequestRef.current.promise.then((next) => {
      if (cancelled || !mounted.current) return
      if (!next) {
        setPhase({
          kind: 'error',
          message: '图纸不存在或已被删除。',
          retry: 'document',
        })
        return
      }
      loadDocumentIntoFrame(next)
      // Document loaded — if the server is already ready (loading-document
      // phase), transition to `ready` so the iframe renders. If the server is
      // still starting, the loading-document effect below will handle the
      // transition once start() resolves.
      setPhase((prev) =>
        prev.kind === 'loading-document' ? { kind: 'ready', url: prev.url } : prev,
      )
      if (frameReadyRef.current) window.raintool.setDiagramEditorReady(next.id, true)
    }).catch((error: unknown) => {
      if (cancelled || !mounted.current) return
      setPhase({
        kind: 'error',
        message: '无法打开图纸。',
        details: error instanceof Error ? error.message : String(error),
        retry: 'document',
      })
    })
    return () => { cancelled = true }
  }, [diagramId, loadDocumentIntoFrame])

  // P0 fix: bounded timeout on document loading. If the document IPC has not
  // returned within DOCUMENT_LOAD_TIMEOUT_MS while the server is ready, flip
  // to a retryable error. This is the regression for the "stuck on 正在启动
  // AI Draw.io…" symptom where the server was up (HTTP 200) but the document
  // load hung and the splash stayed forever.
  useEffect(() => {
    if (phase.kind !== 'loading-document') return
    const timer = window.setTimeout(() => {
      if (!mounted.current) return
      // Only fire if we're STILL in loading-document (document didn't arrive).
      setPhase((prev) => {
        if (prev.kind !== 'loading-document') return prev
        return {
          kind: 'error',
          message: '图纸加载超时。',
          details: `本地服务已就绪，但图纸在 ${DOCUMENT_LOAD_TIMEOUT_MS / 1000}s 内未加载完成。可重试；若持续失败，请检查图纸库是否可访问。`,
          retry: 'document',
        }
      })
    }, DOCUMENT_LOAD_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [phase.kind])

  // Bounded timeout on the iframe→bridge handoff. The embedded Draw.io page
  // must post `raintool:diagram-ready` within FRAME_READY_TIMEOUT_MS of the
  // iframe loading. If it doesn't, the canvas is not usable and the user sees
  // a retryable error (the iframe is reloaded on retry via frameKey bump).
  useEffect(() => {
    if (phase.kind !== 'ready' || frameState !== 'loading') return
    const timer = window.setTimeout(() => setFrameState('error'), FRAME_READY_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [phase.kind, frameState, frameKey])

  useEffect(() => {
    if (phase.kind !== 'ready') return
    const expectedOrigin = new URL(phase.url).origin
    const handleMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== expectedOrigin) return
      // Build the classifier context from current refs.
      const ctx = {
        currentDocumentId: documentRef.current?.id ?? null,
        pendingExportRequestIds: new Set(pendingExportsRef.current.keys()),
        legacyMigrationDone: legacyMigrationDoneRef.current,
      }
      const action = classifyBridgeMessage(event.data, ctx)
      switch (action.kind) {
        case 'ready': {
          frameReadyRef.current = true
          setFrameState('ready')
          const current = documentRef.current
          if (current) {
            window.raintool.setDiagramEditorReady(current.id, true)
            loadDocumentIntoFrame(current)
          }
          for (const request of pendingExportsRef.current.values()) {
            postToFrame({
              type: 'raintool:diagram-export',
              requestId: request.requestId,
              format: request.format,
            })
          }
          pendingExportsRef.current.clear()
          if (!legacyMigrationDoneRef.current) {
            postToFrame({ type: 'raintool:legacy-request' })
          }
          return
        }
        case 'autosave': {
          queueSave(action.xml)
          return
        }
        case 'export-result': {
          window.raintool.completeDiagramExport({
            requestId: action.requestId,
            data: action.data,
            error: action.error,
          })
          return
        }
        case 'legacy-response': {
          void window.raintool.migrateLegacyDiagrams(action.items).then(() => {
            legacyMigrationDoneRef.current = true
            try {
              localStorage.setItem('raintool:legacy-diagrams-migrated-v1', 'true')
            } catch {
              // localStorage may be unavailable in some sandboxed contexts;
              // the ref guard above keeps us idempotent either way.
            }
          })
          return
        }
        case 'ignore':
          return
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [loadDocumentIntoFrame, phase, postToFrame, queueSave])

  useEffect(() => {
    const offChanged = window.raintool.onDiagramChanged(({ document: changed }) => {
      const current = documentRef.current
      if (!current || changed.id !== current.id || changed.revision <= current.revision) return
      const localRevisions = localSaveRevisionsRef.current.get(changed.id)
      if (localRevisions?.delete(changed.revision)) {
        if (localRevisions.size === 0) localSaveRevisionsRef.current.delete(changed.id)
        // This is the acknowledgement of the current canvas's own autosave.
        // Update metadata only; reloading the iframe here interrupts dragging
        // and text editing on every save.
        documentRef.current = changed
        setDocument(changed)
        return
      }
      loadDocumentIntoFrame(changed)
    })
    const offDeleted = window.raintool.onDiagramDeleted(({ id }) => {
      if (id === documentRef.current?.id) {
        setPhase({ kind: 'error', message: '当前图纸已被删除。', retry: 'document' })
      }
    })
    const offExport = window.raintool.onDiagramExportRequested((request) => {
      if (request.id !== documentRef.current?.id) return
      if (frameState !== 'ready') {
        pendingExportsRef.current.set(request.requestId, request)
        return
      }
      postToFrame({
        type: 'raintool:diagram-export',
        requestId: request.requestId,
        format: request.format,
      })
    })
    return () => {
      offChanged()
      offDeleted()
      offExport()
    }
  }, [frameState, loadDocumentIntoFrame, postToFrame])

  const reloadFrame = () => {
    const current = documentRef.current
    if (current) window.raintool.setDiagramEditorReady(current.id, false)
    frameReadyRef.current = false
    setFrameState('loading')
    setFrameKey((value) => value + 1)
  }

  /** Retry dispatcher driven by the error phase's `retry` discriminator. */
  const handleRetry = () => {
    if (phase.kind !== 'error') return
    switch (phase.retry) {
      case 'start':
        void start()
        return
      case 'document': {
        // Re-trigger the document-load effect by clearing the cached request
        // and bumping a ref. The simplest robust path: re-run start() which
        // re-enters loading-document, and the document effect will pick up
        // the same diagramId (its cache is keyed by diagramId).
        documentRequestRef.current = null
        void start()
        return
      }
      case 'frame':
        reloadFrame()
        return
    }
  }

  if (phase.kind === 'error') {
    const title =
      phase.retry === 'start'
        ? 'AI Draw.io 启动失败'
        : phase.retry === 'document'
          ? '图纸加载失败'
          : '绘图工作区加载失败'
    return (
      <StatusCard title={title} description={phase.message} details={phase.details}>
        <ActionButton onClick={handleRetry}>
          {phase.retry === 'frame' ? '重新加载工作区' : '重试'}
        </ActionButton>
      </StatusCard>
    )
  }

  // Accurate splash messaging (P0 fix):
  //   - `starting`           → server is starting (or IPC hasn't returned yet).
  //   - `loading-document`   → server is ready, diagram is loading. Previously
  //                            this state was conflated with "starting", which
  //                            is why users reported "stuck on starting" even
  //                            though the server was already serving HTTP 200.
  //   - `ready` && !document → shouldn't happen (ready implies document
  //                            loaded), but guard anyway with a clear message.
  if (phase.kind === 'starting') {
    return <StatusCard title="正在启动 AI Draw.io 服务…" description="首次启动可能需要几秒钟。" />
  }
  if (phase.kind === 'loading-document' || !document) {
    return (
      <StatusCard
        title={phase.kind === 'loading-document' ? '正在加载图纸…' : '正在准备 AI Draw.io…'}
        description="本地服务已就绪，正在加载图纸。"
      />
    )
  }

  const frameUrl = new URL(phase.url)
  frameUrl.searchParams.set('raintoolDiagram', document.id)

  return (
    <div className="relative h-full w-full bg-bg-app">
      <iframe
        ref={frameRef}
        key={frameKey}
        src={frameUrl.toString()}
        title={`AI Draw.io - ${document.title}`}
        className="h-full w-full border-0 bg-white"
        allow="clipboard-read; clipboard-write"
        referrerPolicy="no-referrer"
        onError={() => {
          frameReadyRef.current = false
          setFrameState('error')
        }}
      />
      {frameState === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-app">
          <StatusCard title="正在加载绘图工作区…" description="本地服务已就绪，正在初始化 Draw.io。" />
        </div>
      )}
      {frameState === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-app">
          <StatusCard title="绘图工作区加载失败" description="本地服务仍在运行，但 Draw.io 工作区未在限定时间内就绪。可重新加载页面。">
            <ActionButton onClick={reloadFrame}>重新加载</ActionButton>
          </StatusCard>
        </div>
      )}
      {syncWarning && (
        <button
          onClick={() => setSyncWarning(null)}
          className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-card border border-amber-300 bg-amber-50 px-3 py-2 text-caption text-amber-800 shadow-float"
        >
          {syncWarning}
        </button>
      )}
    </div>
  )
}

function StatusCard({
  title,
  description,
  details,
  children,
}: {
  title: string
  description: string
  details?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-48 w-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-card border border-line bg-bg-surface p-5 text-center shadow-float">
        <div className="text-page text-ink-primary">{title}</div>
        <div className="mt-2 text-body text-ink-secondary">{description}</div>
        {details && (
          <details className="mt-3 text-left text-caption text-ink-tertiary">
            <summary className="cursor-pointer">技术详情</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-btn bg-bg-subtle p-2">{details}</pre>
          </details>
        )}
        {children && <div className="mt-4 flex justify-center">{children}</div>}
      </div>
    </div>
  )
}

function ActionButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-btn bg-accent px-4 py-2 text-body text-white hover:opacity-90"
    >
      {children}
    </button>
  )
}
