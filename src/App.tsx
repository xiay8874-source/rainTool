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

  // 启动时恢复:工作区(标签+分组+内容)+ 收藏夹
  useEffect(() => {
    hydrateWorkspace()
    hydrateFavorites()
  }, [hydrateWorkspace, hydrateFavorites])

  // 启动时静默检查更新(24h 节流),有更新则在设置图标显示红点
  useEffect(() => {
    const ONE_DAY = 24 * 60 * 60 * 1000
    ;(async () => {
      try {
        const w = window as unknown as {
          raintool?: {
            getLastCheck: () => Promise<number | undefined>
            setLastCheck: (ts: number) => Promise<void>
            checkForUpdates: () => Promise<{ hasUpdate: boolean; current?: string; error?: string }>
          }
        }
        if (!w.raintool) return
        const last = await w.raintool.getLastCheck()
        if (last && Date.now() - last < ONE_DAY) return // 节流:24h 内不重复检查
        const result = await w.raintool.checkForUpdates()
        await w.raintool.setLastCheck(Date.now())
        if (result.hasUpdate) setHasUpdate(true)
      } catch {
        /* 静默失败,不打扰用户 */
      }
    })()
  }, [setHasUpdate])

  // 启动时恢复:工作区(标签+分组+内容)+ 收藏夹
  useEffect(() => {
    hydrateWorkspace()
    hydrateFavorites()
  }, [hydrateWorkspace, hydrateFavorites])

  // 应用退出前确保最新状态已落盘(electron before-quit 也会触发)
  useEffect(() => {
    const flush = () => {
      useAppStore.getState().persist()
      useFavoritesStore.getState().persist()
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  // ⌘B / Ctrl+B 唤起收藏夹;⌘F / Ctrl+F 派发查找事件(由当前可见工具的 FindBar 响应)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
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
