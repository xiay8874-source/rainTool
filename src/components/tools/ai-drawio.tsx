import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DiagramDocument,
  DiagramExportRequest,
  DiagramUpdateResult,
  LegacyDiagramInput,
} from '../../../electron/diagram-types'
import type { ToolProps } from './shared'

type Phase =
  | { kind: 'starting' }
  | { kind: 'ready'; url: string }
  | { kind: 'error'; message: string; details?: string }

type BridgeMessage = {
  protocol?: string
  type?: string
  diagramId?: string
  revision?: number
  xml?: string
  requestId?: string
  data?: string
  items?: LegacyDiagramInput[]
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

  useEffect(() => { onDiagramIdRef.current = onDiagramId }, [onDiagramId])

  const postToFrame = useCallback((message: Record<string, unknown>) => {
    const frameWindow = frameRef.current?.contentWindow
    const origin = frameOriginRef.current
    if (!frameWindow || !origin) return
    frameWindow.postMessage({ protocol: 'raintool-diagram-v1', ...message }, origin)
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
        setPhase({ kind: 'ready', url: result.url })
      } else {
        frameOriginRef.current = null
        setPhase({ kind: 'error', message: result.message, details: result.details })
      }
    } catch (error) {
      if (!mounted.current) return
      setPhase({
        kind: 'error',
        message: '无法请求启动 AI Draw.io 服务。',
        details: error instanceof Error ? error.message : String(error),
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
        setPhase({ kind: 'error', message: '图纸不存在或已被删除。' })
        return
      }
      loadDocumentIntoFrame(next)
      if (frameReadyRef.current) window.raintool.setDiagramEditorReady(next.id, true)
    }).catch((error: unknown) => {
      if (cancelled || !mounted.current) return
      setPhase({
        kind: 'error',
        message: '无法打开图纸。',
        details: error instanceof Error ? error.message : String(error),
      })
    })
    return () => { cancelled = true }
  }, [diagramId, loadDocumentIntoFrame])

  useEffect(() => {
    if (phase.kind !== 'ready' || frameState !== 'loading') return
    const timer = window.setTimeout(() => setFrameState('error'), 20_000)
    return () => window.clearTimeout(timer)
  }, [phase.kind, frameState, frameKey])

  useEffect(() => {
    if (phase.kind !== 'ready') return
    const expectedOrigin = new URL(phase.url).origin
    const handleMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== expectedOrigin) return
      const message = event.data
      if (message?.protocol !== 'raintool-diagram-v1') return
      if (message.type === 'raintool:diagram-ready') {
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
        if (localStorage.getItem('raintool:legacy-diagrams-migrated-v1') !== 'true') {
          postToFrame({ type: 'raintool:legacy-request' })
        }
        return
      }
      if (
        message.type === 'raintool:diagram-autosave' &&
        message.diagramId === documentRef.current?.id &&
        typeof message.xml === 'string'
      ) {
        queueSave(message.xml)
        return
      }
      if (
        message.type === 'raintool:diagram-export-result' &&
        typeof message.requestId === 'string'
      ) {
        window.raintool.completeDiagramExport({
          requestId: message.requestId,
          data: message.data,
          error: message.data ? undefined : 'Draw.io 未返回导出数据',
        })
        return
      }
      if (message.type === 'raintool:legacy-response' && Array.isArray(message.items)) {
        void window.raintool.migrateLegacyDiagrams(message.items).then(() => {
          localStorage.setItem('raintool:legacy-diagrams-migrated-v1', 'true')
        })
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
        setPhase({ kind: 'error', message: '当前图纸已被删除。' })
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

  if (phase.kind === 'error') {
    return (
      <StatusCard title="AI Draw.io 启动失败" description={phase.message} details={phase.details}>
        <ActionButton onClick={() => void start()}>重试启动</ActionButton>
      </StatusCard>
    )
  }

  if (phase.kind === 'starting' || !document) {
    return <StatusCard title="正在启动 AI Draw.io…" description="首次启动可能需要几秒钟。" />
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
          <StatusCard title="绘图工作区加载失败" description="本地服务仍在运行，可以重新加载页面。">
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
