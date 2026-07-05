import { CATEGORIES } from '../tools/catalog'
import { CategoryIcon, StarIcon, CollapseIcon, ExpandIcon } from '../icons'
import { useUIStore } from '@/store/ui'

export function IconRail() {
  const favoritesOpen = useUIStore((s) => s.favoritesOpen)
  const toggleFavorites = useUIStore((s) => s.toggleFavorites)
  const tabSidebarCollapsed = useUIStore((s) => s.tabSidebarCollapsed)
  const toggleTabSidebar = useUIStore((s) => s.toggleTabSidebar)
  const activeCategory = useUIStore((s) => s.activeCategory)
  const setActiveCategory = useUIStore((s) => s.setActiveCategory)

  return (
    <div className="flex h-full w-12 flex-col items-center border-r border-line bg-bg-surface py-2">
      <button
        onClick={toggleTabSidebar}
        className="mb-2 flex h-7 w-7 items-center justify-center rounded-btn text-ink-tertiary hover:bg-bg-hover hover:text-ink-secondary"
        title={tabSidebarCollapsed ? '展开标签栏' : '收起标签栏'}
      >
        {tabSidebarCollapsed ? <ExpandIcon /> : <CollapseIcon />}
      </button>

      <div className="my-1 h-px w-6 bg-line" />

      <div className="flex flex-1 flex-col items-center gap-1">
        {CATEGORIES.map((cat) => {
          const active = activeCategory === cat.id
          return (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(active ? null : cat.id)}
              className="group relative flex h-8 w-8 items-center justify-center rounded-btn text-ink-tertiary hover:bg-bg-hover hover:text-ink-secondary"
              title={cat.name}
            >
              <CategoryIcon id={cat.id} />
              {active && (
                <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-accent" />
              )}
            </button>
          )
        })}
      </div>

      <div className="my-1 h-px w-6 bg-line" />

      <button
        onClick={toggleFavorites}
        className={`flex h-8 w-8 items-center justify-center rounded-btn hover:bg-bg-hover ${
          favoritesOpen ? 'text-accent' : 'text-ink-tertiary hover:text-ink-secondary'
        }`}
        title="收藏夹 (⌘B)"
      >
        <StarIcon />
      </button>
    </div>
  )
}
