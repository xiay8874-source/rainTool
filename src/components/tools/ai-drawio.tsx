import { useCallback, useEffect, useRef, useState } from 'react'

type Phase =
  | { kind: 'starting' }
  | { kind: 'ready'; url: string }
  | { kind: 'error'; message: string; details?: string }

export default function AiDrawio() {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
  const [frameState, setFrameState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [frameKey, setFrameKey] = useState(0)
  const mounted = useRef(true)

  const start = useCallback(async () => {
    setPhase({ kind: 'starting' })
    setFrameState('loading')
    try {
      const result = await window.raintool.startAiDrawio()
      if (!mounted.current) return
      if (result.status === 'ready') {
        setPhase({ kind: 'ready', url: result.url })
      } else {
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
    }
  }, [start])

  useEffect(() => {
    if (phase.kind !== 'ready' || frameState !== 'loading') return
    const timer = window.setTimeout(() => setFrameState('error'), 20_000)
    return () => window.clearTimeout(timer)
  }, [phase.kind, frameState, frameKey])

  const reloadFrame = () => {
    setFrameState('loading')
    setFrameKey((value) => value + 1)
  }

  if (phase.kind === 'starting') {
    return <StatusCard title="正在启动 AI Draw.io…" description="首次启动可能需要几秒钟。" />
  }

  if (phase.kind === 'error') {
    return (
      <StatusCard title="AI Draw.io 启动失败" description={phase.message} details={phase.details}>
        <ActionButton onClick={() => void start()}>重试启动</ActionButton>
      </StatusCard>
    )
  }

  return (
    <div className="relative h-full w-full bg-bg-app">
      <iframe
        key={frameKey}
        src={phase.url}
        title="AI Draw.io"
        className="h-full w-full border-0 bg-white"
        allow="clipboard-read; clipboard-write"
        referrerPolicy="no-referrer"
        onLoad={() => setFrameState('ready')}
        onError={() => setFrameState('error')}
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
