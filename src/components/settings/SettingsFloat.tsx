import { useEffect, useState, useRef } from 'react'
import { useUIStore } from '@/store/ui'
import { CloseIcon, SettingsIcon, DownloadIcon } from '../icons'
import type { ShortcutMap } from '@/types/raintool'

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date'; current: string }
  | {
      status: 'available'
      version: string
      name: string
      notes: string
      url: string
      publishedAt: string
      current: string
    }
  | { status: 'downloading'; version: string; notes: string; publishedAt: string; percent: number }
  | { status: 'downloaded'; version: string; notes: string; publishedAt: string; dmgPath: string }
  | { status: 'installing' }
  | { status: 'error'; message: string }

export function SettingsFloat() {
  const open = useUIStore((s) => s.settingsOpen)
  const setOpen = useUIStore((s) => s.setSettingsOpen)
  const setHasUpdate = useUIStore((s) => s.setHasUpdate)
  const updateInfo = useUIStore((s) => s.updateInfo)
  const setUpdateInfo = useUIStore((s) => s.setUpdateInfo)
  const [state, setState] = useState<CheckState>({ status: 'idle' })
  // 真实版本号:启动时从主进程读取(app.getVersion()),不再硬编码
  const [appVersion, setAppVersion] = useState('—')

  useEffect(() => {
    window.raintool?.getVersion().then(setAppVersion).catch(() => {})
  }, [])

  // 启动时若 store 里已有检测到的新版信息(来自 App.tsx 静默检查),恢复展示
  useEffect(() => {
    if (updateInfo && state.status === 'idle') {
      // 需要再查一次拿到完整 url(静默检查只存了 version/notes/publishedAt)
      // 这里先展示已有信息,用户点「立即检查」会刷新 url
      setState({
        status: 'available',
        version: updateInfo.version,
        name: updateInfo.version,
        notes: updateInfo.notes,
        url: '', // 静默检查未存 url,点下载时若为空会触发重新检查
        publishedAt: updateInfo.publishedAt,
        current: appVersion,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateInfo])

  if (!open) return null

  const check = async () => {
    setState({ status: 'checking' })
    try {
      const result = await window.raintool?.checkForUpdates()
      if (!result) {
        setState({ status: 'error', message: '更新服务不可用' })
        return
      }
      await window.raintool?.setLastCheck(Date.now())
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
        setUpdateInfo({
          version: result.version,
          notes: result.notes,
          publishedAt: result.publishedAt,
        })
      } else if (result.error) {
        setState({ status: 'error', message: result.error })
      } else {
        setState({ status: 'up-to-date', current: result.current ?? appVersion })
        setHasUpdate(false)
        setUpdateInfo(null)
      }
    } catch (e) {
      setState({ status: 'error', message: (e as Error).message })
    }
  }

  // 下载更新:订阅进度事件,下载完成切 downloaded 状态
  const download = async () => {
    let url = state.status === 'available' ? state.url : ''
    const info =
      state.status === 'available'
        ? { version: state.version, notes: state.notes, publishedAt: state.publishedAt }
        : null
    if (!info) return
    // 静默恢复的 available 状态 url 可能为空,重新检查一次拿 url
    if (!url) {
      try {
        const r = await window.raintool?.checkForUpdates()
        if (r?.hasUpdate) url = r.url
      } catch {
        /* ignore */
      }
      if (!url) {
        setState({ status: 'error', message: '无法获取下载地址,请稍后重试' })
        return
      }
    }
    setState({
      status: 'downloading',
      version: info.version,
      notes: info.notes,
      publishedAt: info.publishedAt,
      percent: 0,
    })
    const unsub = window.raintool?.onUpdateProgress((p) => {
      setState((s) =>
        s.status === 'downloading' ? { ...s, percent: p.percent } : s,
      )
    })
    try {
      const dmgPath = await window.raintool?.downloadUpdate(url)
      unsub?.()
      if (!dmgPath) throw new Error('下载失败')
      setState({
        status: 'downloaded',
        version: info.version,
        notes: info.notes,
        publishedAt: info.publishedAt,
        dmgPath,
      })
    } catch (e) {
      unsub?.()
      setState({ status: 'error', message: '下载失败:' + (e as Error).message })
    }
  }

  // 安装:挂载 dmg → 替换 app → relaunch 退出(主进程内完成)
  const install = async () => {
    if (state.status !== 'downloaded') return
    setState({ status: 'installing' })
    try {
      await window.raintool?.installUpdate(state.dmgPath)
      // installUpdate 内部会 app.relaunch() + exit(0),此处不会返回
      // 若返回说明失败
      setState({ status: 'error', message: '安装失败,请重试' })
    } catch (e) {
      setState({ status: 'error', message: '安装失败:' + (e as Error).message })
    }
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
            <span className="font-mono text-code text-ink-primary">v{appVersion}</span>
          </div>

          <div className="h-px bg-line" />

          {/* 检查更新 */}
          <div className="flex items-center justify-between">
            <span className="text-caption text-ink-tertiary">检查更新</span>
            <button
              onClick={check}
              disabled={state.status === 'checking' || state.status === 'downloading' || state.status === 'installing'}
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
              {state.message}
            </div>
          )}
          {(state.status === 'available' ||
            state.status === 'downloading' ||
            state.status === 'downloaded') && (
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

              {/* 下载中:进度条 */}
              {state.status === 'downloading' && (
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-label text-ink-tertiary">
                    <span>下载中…</span>
                    <span className="font-mono">{state.percent}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle">
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-150"
                      style={{ width: `${state.percent}%` }}
                    />
                  </div>
                </div>
              )}

              {/* available:下载按钮 */}
              {state.status === 'available' && (
                <button
                  onClick={download}
                  className="flex items-center justify-center gap-1 rounded-btn bg-accent px-2 py-1 text-caption text-white hover:opacity-90"
                >
                  <DownloadIcon size={12} />
                  下载并安装
                </button>
              )}
              {/* downloaded:安装重启按钮 */}
              {state.status === 'downloaded' && (
                <button
                  onClick={install}
                  className="rounded-btn bg-accent px-2 py-1 text-caption text-white hover:opacity-90"
                >
                  重启安装
                </button>
              )}
            </div>
          )}
          {state.status === 'installing' && (
            <div className="rounded-btn bg-bg-subtle px-3 py-2 text-caption text-ink-secondary">
              正在安装,请稍候…
            </div>
          )}

          <div className="h-px bg-line" />

          {/* 快捷键自定义 */}
          <ShortcutSettings />

          <div className="h-px bg-line" />
        </div>
      </div>
    </>
  )
}

// ============ 快捷键设置 ============

const SHORTCUT_LABELS: { key: keyof ShortcutMap; label: string; desc: string }[] = [
  { key: 'captureRegion', label: '区域截图', desc: '拖拽框选屏幕区域' },
  { key: 'captureScreen', label: '全屏截图', desc: '截取整个屏幕' },
  { key: 'captureWindow', label: '窗口截图', desc: '截取指定应用窗口' },
  { key: 'togglePins', label: '显示/隐藏所有贴图', desc: '一键切换所有贴图可见性' },
]

const DEFAULT_SHORTCUTS: ShortcutMap = {
  captureRegion: 'CommandOrControl+Shift+A',
  captureScreen: 'CommandOrControl+Shift+S',
  captureWindow: 'CommandOrControl+Shift+W',
  togglePins: 'CommandOrControl+Shift+P',
}

/** 把 Electron accelerator 格式转为可读显示 */
function formatAccel(accel: string): string {
  return accel
    .replace(/CommandOrControl/g, '⌘')
    .replace(/Control/g, '⌃')
    .replace(/Shift/g, '⇧')
    .replace(/Alt/g, '⌥')
    .replace(/\+/g, '')
}

function ShortcutSettings() {
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(DEFAULT_SHORTCUTS)
  const [editing, setEditing] = useState<keyof ShortcutMap | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const recordingRef = useRef(false)

  useEffect(() => {
    window.raintool?.getShortcuts().then((map) => {
      if (map) setShortcuts(map)
    })
  }, [])

  // 录入快捷键:监听 keydown
  useEffect(() => {
    if (!editing) return

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      // 只认修饰键组合,单独按修饰键不触发
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return

      const parts: string[] = []
      if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl')
      if (e.shiftKey) parts.push('Shift')
      if (e.altKey) parts.push('Alt')

      // 主键
      let key = e.key
      if (key === ' ') key = 'Space'
      else if (key.length === 1) key = key.toUpperCase()
      parts.push(key)

      const accel = parts.join('+')

      // 检查内部冲突
      const conflictKey = (Object.keys(shortcuts) as (keyof ShortcutMap)[]).find(
        (k) => k !== editing && shortcuts[k] === accel,
      )
      if (conflictKey) {
        setConflict(`与「${SHORTCUT_LABELS.find((s) => s.key === conflictKey)?.label}」冲突`)
        return
      }

      // 检查系统冲突
      recordingRef.current = true
      window.raintool?.checkShortcutConflict(accel).then((isConflict) => {
        recordingRef.current = false
        if (isConflict) {
          setConflict('此快捷键已被系统占用,请换一个组合')
        } else {
          setConflict(null)
          const newMap = { ...shortcuts, [editing]: accel }
          setShortcuts(newMap)
          window.raintool?.updateShortcuts(newMap)
          setEditing(null)
          setSaved(editing)
          setTimeout(() => setSaved(null), 1500)
        }
      })
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editing, shortcuts])

  const handleReset = () => {
    setShortcuts(DEFAULT_SHORTCUTS)
    window.raintool?.updateShortcuts(DEFAULT_SHORTCUTS)
    setEditing(null)
    setConflict(null)
    setSaved('reset')
    setTimeout(() => setSaved(null), 1500)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-caption text-ink-tertiary">截图快捷键(系统全局)</span>
        <button
          onClick={handleReset}
          className="text-label text-ink-tertiary hover:text-ink-secondary"
        >
          恢复默认
        </button>
      </div>

      {SHORTCUT_LABELS.map(({ key, label, desc }) => (
        <div
          key={key}
          className={`flex items-center justify-between rounded-btn border px-2.5 py-1.5 ${
            editing === key
              ? 'border-accent bg-accent-bg/30'
              : conflict && editing === key
                ? 'border-danger bg-danger/5'
                : 'border-line bg-bg-subtle'
          }`}
        >
          <div>
            <div className="text-caption text-ink-primary">{label}</div>
            <div className="text-label text-ink-tertiary">{desc}</div>
          </div>
          <div className="flex items-center gap-1.5">
            {editing === key ? (
              <>
                <kbd className="rounded-btn border border-accent bg-bg-surface px-2 py-0.5 font-mono text-label text-accent">
                  按下组合键…
                </kbd>
                <button
                  onClick={() => { setEditing(null); setConflict(null) }}
                  className="text-label text-ink-tertiary hover:text-ink-secondary"
                >
                  ✕
                </button>
              </>
            ) : (
              <>
                <kbd className="rounded-btn border border-line bg-bg-surface px-2 py-0.5 font-mono text-label text-ink-secondary">
                  {formatAccel(shortcuts[key])}
                </kbd>
                <button
                  onClick={() => { setEditing(key); setConflict(null) }}
                  className="text-label text-ink-tertiary hover:text-ink-secondary"
                >
                  ✎
                </button>
              </>
            )}
          </div>
        </div>
      ))}

      {conflict && editing && (
        <div className="rounded-btn bg-danger/10 px-2.5 py-1.5 text-label text-danger">
          ⚠ {conflict}
        </div>
      )}

      {saved && (
        <div className="rounded-btn bg-accent-bg px-2.5 py-1.5 text-label text-accent">
          ✓ {saved === 'reset' ? '已恢复默认' : '已保存'}
        </div>
      )}
    </div>
  )
}
