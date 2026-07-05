import { useEffect } from 'react'
import { IconRail } from './components/layout/IconRail'
import { TabSidebar } from './components/layout/TabSidebar'
import { Workspace } from './components/layout/Workspace'
import { FavoritesFloat } from './components/favorites/FavoritesFloat'
import { useUIStore } from '@/store/ui'
import { useFavoritesStore } from '@/store/favorites'
import { useAppStore } from '@/store/tabs'

export default function App() {
  const toggleFavorites = useUIStore((s) => s.toggleFavorites)
  const hydrateFavorites = useFavoritesStore((s) => s.hydrate)
  const hydrateWorkspace = useAppStore((s) => s.hydrate)

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
      </div>
    </div>
  )
}
