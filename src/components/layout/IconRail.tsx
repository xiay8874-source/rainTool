import { CATEGORIES } from '../tools/catalog'
import { CategoryIcon, StarIcon, SettingsIcon, CollapseIcon, ExpandIcon } from '../icons'
import { useUIStore } from '@/store/ui'
import { useAppStore } from '@/store/tabs'

export function IconRail() {
  const favoritesOpen = useUIStore((s) => s.favoritesOpen)
  const toggleFavorites = useUIStore((s) => s.toggleFavorites)
  const tabSidebarCollapsed = useUIStore((s) => s.tabSidebarCollapsed)
  const toggleTabSidebar = useUIStore((s) => s.toggleTabSidebar)
  const activeCategory = useUIStore((s) => s.activeCategory)
  const setActiveCategory = useUIStore((s) => s.setActiveCategory)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const toggleSettings = useUIStore((s) => s.toggleSettings)
  const settingsOpen = useUIStore((s) => s.settingsOpen)
  const hasUpdate = useUIStore((s) => s.hasUpdate)

  // 点击分类图标:切到该分类的工具选择面板(取消当前活动标签,让 EmptyState 显示)
  const handleCategoryClick = (catId: typeof CATEGORIES[number]['id']) => {
    const next = activeCategory === catId ? null : catId
    setActiveCategory(next)
    // 清空活动标签,触发 EmptyState(按分类筛选工具列表)
    setActiveTab(null)
  }

  return (
    <div className="drag flex h-full w-12 flex-col items-center border-r border-line bg-bg-surface pb-2">
      {/* 顶部:固定 60px 高,与 TabSidebar/Workspace 顶栏对齐,底 border 形成统一分隔线 */}
      <div className="flex h-[60px] w-full items-center justify-center pt-7">
        <button
          onClick={toggleTabSidebar}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-ink-tertiary hover:bg-bg-hover hover:text-ink-secondary no-drag"
          title={tabSidebarCollapsed ? '展开标签栏' : '收起标签栏'}
        >
          {tabSidebarCollapsed ? <ExpandIcon /> : <CollapseIcon />}
        </button>
      </div>

      <div className="mb-2 h-px w-full bg-line" />

      <div className="flex flex-1 flex-col items-center gap-1">
        {CATEGORIES.map((cat) => {
          const active = activeCategory === cat.id
          return (
            <button
              key={cat.id}
              onClick={() => handleCategoryClick(cat.id)}
              className="group relative flex h-8 w-8 items-center justify-center rounded-btn text-ink-tertiary hover:bg-bg-hover hover:text-ink-secondary no-drag"
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
        className={`flex h-8 w-8 items-center justify-center rounded-btn hover:bg-bg-hover no-drag ${
          favoritesOpen ? 'text-accent' : 'text-ink-tertiary hover:text-ink-secondary'
        }`}
        title="收藏夹 (⌘B)"
      >
        <StarIcon />
      </button>

      <button
        onClick={toggleSettings}
        className={`relative flex h-8 w-8 items-center justify-center rounded-btn hover:bg-bg-hover no-drag ${
          settingsOpen ? 'text-accent' : 'text-ink-tertiary hover:text-ink-secondary'
        }`}
        title="设置 / 检查更新"
      >
        <SettingsIcon />
        {hasUpdate && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-danger" />
        )}
      </button>
    </div>
  )
}
