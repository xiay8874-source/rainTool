import { useEffect } from 'react'
import { IconRail } from './components/layout/IconRail'
import { TabSidebar } from './components/layout/TabSidebar'
import { Workspace } from './components/layout/Workspace'
import { FavoritesFloat } from './components/favorites/FavoritesFloat'
import { SettingsFloat } from './components/settings/SettingsFloat'
import { useUIStore } from '@/store/ui'
import { useFavoritesStore } from '@/store/favorites'
import { useAppStore } from '@/store/tabs'

export default function App() {
  const toggleFavorites = useUIStore((s) => s.toggleFavorites)
  const hydrateFavorites = useFavoritesStore((s) => s.hydrate)
  const hydrateWorkspace = useAppStore((s) => s.hydrate)
  const setHasUpdate = useUIStore((s) => s.setHasUpdate)
  const setUpdateInfo = useUIStore((s) => s.setUpdateInfo)

  // 启动时恢复:工作区(标签+分组+内容)+ 收藏夹
  useEffect(() => {
    hydrateWorkspace()
    hydrateFavorites()
  }, [hydrateWorkspace, hydrateFavorites])

  // 启动时静默检查更新(24h 节流),有更新则在设置图标显示红点 + 存 release notes
  useEffect(() => {
    const ONE_DAY = 24 * 60 * 60 * 1000
    ;(async () => {
      try {
        if (!window.raintool) return
        const last = await window.raintool.getLastCheck()
        if (last && Date.now() - last < ONE_DAY) return // 节流:24h 内不重复检查
        const result = await window.raintool.checkForUpdates()
        await window.raintool.setLastCheck(Date.now())
        if (result.hasUpdate) {
          setHasUpdate(true)
          setUpdateInfo({
            version: result.version,
            notes: result.notes,
            publishedAt: result.publishedAt,
          })
        }
      } catch {
        /* 静默失败,不打扰用户 */
      }
    })()
  }, [setHasUpdate, setUpdateInfo])

  // 启动时恢复:工作区(标签+分组+内容)+ 收藏夹
  useEffect(() => {
    hydrateWorkspace()
    hydrateFavorites()
  }, [hydrateWorkspace, hydrateFavorites])

  // 退出前 flush 工作区 + 收藏区(主进程 before-quit / installUpdate 触发 app:flush)
  // 替代不可靠的 beforeunload:主进程发 app:flush → 这里 await 两个 flush → 回 app:flushed
  useEffect(() => {
    window.raintool?.onFlush?.(async () => {
      await Promise.all([
        useAppStore.getState().flush(),
        useFavoritesStore.getState().flush(),
      ])
    })
  }, [])

  // ⌘B 收藏夹;⌘F 查找;⌘[/⌘] 或 Alt+←/→ 标签前进/后退
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      // ⌘[ 后退 / ⌘] 前进
      if (mod && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        const store = useAppStore.getState()
        if (e.key === '[') store.goBack()
        else store.goForward()
        return
      }
      // Alt+← 后退 / Alt+→ 前进(鼠标快捷键习惯)
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        const store = useAppStore.getState()
        if (e.key === 'ArrowLeft') store.goBack()
        else store.goForward()
        return
      }
      if (!mod) return
      const k = e.key.toLowerCase()
      if (k === 'b') {
        e.preventDefault()
        toggleFavorites()
      } else if (k === 'f') {
        // 派发自定义事件:可见工具的 FindBar 监听并打开/聚焦
        // 用 CustomEvent 而非 querySelector('[data-search-input]'),
        // 因为浮动查找栏由状态驱动,且 keep-alive 下隐藏标签页不响应
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('raintool:find'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleFavorites])

  // 鼠标后退/前进侧键(macOS):订阅主进程的 nav:mouse 事件
  useEffect(() => {
    const unsub = window.raintool?.onMouseNav?.((direction) => {
      const store = useAppStore.getState()
      if (direction < 0) store.goBack()
      else store.goForward()
    })
    return () => unsub?.()
  }, [])

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-bg-app">
      <IconRail />
      <TabSidebar />
      <div className="relative flex-1 overflow-hidden">
        <Workspace />
        <FavoritesFloat />
        <SettingsFloat />
      </div>
    </div>
  )
}
