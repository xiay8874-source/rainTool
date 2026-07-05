import { useEffect } from 'react'
import { IconRail } from './layout/IconRail'
import { TabSidebar } from './layout/TabSidebar'
import { Workspace } from './layout/Workspace'
import { FavoritesFloat } from './favorites/FavoritesFloat'
import { useUIStore } from '@/store/ui'
import { useFavoritesStore } from '@/store/favorites'

export default function App() {
  const toggleFavorites = useUIStore((s) => s.toggleFavorites)
  const hydrate = useFavoritesStore((s) => s.hydrate)

  // 启动时加载持久化的收藏
  useEffect(() => {
    hydrate()
  }, [hydrate])

  // ⌘B / Ctrl+B 唤起收藏夹
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleFavorites()
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
