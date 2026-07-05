import { useState } from 'react'
import { useUIStore } from '@/store/ui'
import { CloseIcon, SettingsIcon } from '../icons'

// 当前版本(与 package.json 同步,打包后由 electron 读取)
const APP_VERSION = '0.1.0'

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date'; current: string }
  | { status: 'available'; version: string; name: string; notes: string; url: string; publishedAt: string; current: string }
  | { status: 'error'; message: string }

export function SettingsFloat() {
  const open = useUIStore((s) => s.settingsOpen)
  const setOpen = useUIStore((s) => s.setSettingsOpen)
  const setHasUpdate = useUIStore((s) => s.setHasUpdate)
  const [state, setState] = useState<CheckState>({ status: 'idle' })

  if (!open) return null

  const check = async () => {
    setState({ status: 'checking' })
    try {
      const w = window as unknown as {
        raintool?: {
          checkForUpdates: () => Promise<
            | { hasUpdate: true; version: string; name: string; notes: string; url: string; publishedAt: string; current: string }
            | { hasUpdate: false; current?: string; error?: string }
          >
          setLastCheck: (ts: number) => Promise<void>
        }
      }
      const result = await w.raintool?.checkForUpdates()
      if (!result) {
        setState({ status: 'error', message: '更新服务不可用' })
        return
      }
      await w.raintool?.setLastCheck(Date.now())
      if (result.hasUpdate) {
        setState({
          status: 'available',
          version: result.version,
          name: result.name,
          notes: result.notes,
          url: result.url,
          publishedAt: result.publishedAt,
          current: result.current,
        })
        setHasUpdate(true)
      } else if (result.error) {
        setState({ status: 'error', message: result.error })
      } else {
        setState({ status: 'up-to-date', current: result.current ?? APP_VERSION })
        setHasUpdate(false)
      }
    } catch (e) {
      setState({ status: 'error', message: (e as Error).message })
    }
  }

  const openDownload = async () => {
    if (state.status !== 'available') return
    const w = window as unknown as { raintool?: { openReleaseUrl: (url: string) => Promise<void> } }
    await w.raintool?.openReleaseUrl(state.url)
  }

  return (
    <>
      {/* 点击遮罩关闭 */}
      <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      <div className="absolute right-3 top-12 z-50 flex w-80 flex-col overflow-hidden rounded-card border border-line-strong bg-bg-surface shadow-float">
        {/* 头部 */}
        <div className="drag flex items-center gap-1.5 border-b border-line px-3 py-2">
          <SettingsIcon size={14} className="text-ink-tertiary" />
          <span className="text-page text-ink-primary">设置</span>
          <button
            onClick={() => setOpen(false)}
            className="no-drag absolute right-2 flex h-5 w-5 items-center justify-center rounded-btn text-ink-tertiary hover:bg-bg-hover"
          >
            <CloseIcon size={12} />
          </button>
        </div>

        {/* 内容 */}
        <div className="flex flex-col gap-3 p-4">
          {/* 关于 */}
          <div className="flex items-center justify-between">
            <span className="text-caption text-ink-tertiary">当前版本</span>
            <span className="font-mono text-code text-ink-primary">v{APP_VERSION}</span>
          </div>

          <div className="h-px bg-line" />

          {/* 检查更新 */}
          <div className="flex items-center justify-between">
            <span className="text-caption text-ink-tertiary">检查更新</span>
            <button
              onClick={check}
              disabled={state.status === 'checking'}
              className="rounded-btn border border-line px-2 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover hover:text-ink-primary disabled:opacity-40"
            >
              {state.status === 'checking' ? '检查中…' : '立即检查'}
            </button>
          </div>

          {/* 检查结果 */}
          {state.status === 'up-to-date' && (
            <div className="rounded-btn bg-bg-subtle px-3 py-2 text-caption text-ink-secondary">
              ✓ 已是最新版本 (v{state.current})
            </div>
          )}
          {state.status === 'error' && (
            <div className="rounded-btn bg-bg-subtle px-3 py-2 text-caption text-danger">
              检查失败:{state.message}
            </div>
          )}
          {state.status === 'available' && (
            <div className="flex flex-col gap-2 rounded-btn border border-accent/30 bg-accent-bg/50 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-caption text-accent">发现新版本</span>
                <span className="font-mono text-code text-accent">v{state.version}</span>
              </div>
              <div className="text-label text-ink-tertiary">
                {new Date(state.publishedAt).toLocaleDateString()} 发布
              </div>
              {state.notes && (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-btn bg-bg-surface/60 p-2 text-label text-ink-secondary">
                  {state.notes}
                </pre>
              )}
              <button
                onClick={openDownload}
                className="rounded-btn bg-accent px-2 py-1 text-caption text-white hover:opacity-90"
              >
                前往下载
              </button>
            </div>
          )}

          <div className="h-px bg-line" />

          {/* 快捷键提示 */}
          <div className="flex flex-col gap-1 text-label text-ink-tertiary">
            <div className="flex justify-between">
              <span>收藏夹</span>
              <span className="font-mono">⌘B</span>
            </div>
            <div className="flex justify-between">
              <span>查找替换</span>
              <span className="font-mono">⌘F</span>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
