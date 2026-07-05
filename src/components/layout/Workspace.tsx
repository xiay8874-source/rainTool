import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react'
import { useAppStore } from '@/store/tabs'
import { useUIStore } from '@/store/ui'
import { useFavoritesStore, snapshotTab, snapshotGroup } from '@/store/favorites'
import { TOOLS, getTool, CATEGORIES } from '../tools/catalog'
import { BackIcon, ForwardIcon } from '../icons'
import type { ToolProps } from '../tools/shared'

// 懒加载工具组件
const toolCache = new Map<string, ComponentType<ToolProps>>()
function loadTool(toolId: string) {
  if (toolCache.has(toolId)) return toolCache.get(toolId)!
  const def = getTool(toolId)
  if (!def) return null
  const Comp = lazy(() => def.loader().then((m) => ({ default: m.default })))
  toolCache.set(toolId, Comp)
  return Comp
}

export function Workspace() {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const tabs = useAppStore((s) => s.tabs)
  const groups = useAppStore((s) => s.groups)
  const openTab = useAppStore((s) => s.openTab)
  const setTabInput = useAppStore((s) => s.setTabInput)
  const duplicateTab = useAppStore((s) => s.duplicateTab)
  const canGoBack = useAppStore((s) => s.canGoBack())
  const canGoForward = useAppStore((s) => s.canGoForward())
  const goBack = useAppStore((s) => s.goBack)
  const goForward = useAppStore((s) => s.goForward)
  const activeCategory = useUIStore((s) => s.activeCategory)
  const addFavTab = useFavoritesStore((s) => s.addTab)
  const addFavGroup = useFavoritesStore((s) => s.addGroup)

  const activeTab = tabs.find((t) => t.id === activeTabId)

  // 收藏当前标签页
  const handleFavTab = () => {
    if (!activeTab) return
    const tool = getTool(activeTab.toolId)
    addFavTab(activeTab.title || tool?.name || activeTab.toolId, snapshotTab(activeTab))
  }
  // 收藏当前标签所在的整个分组
  const handleFavGroup = () => {
    if (!activeTab?.groupId) return
    const group = groups.find((g) => g.id === activeTab.groupId)
    if (!group) return
    addFavGroup(group.name, snapshotGroup(group, tabs))
  }

  // 无活动标签时,显示分类的工具选择面板
  if (!activeTab) {
    return <EmptyState onOpenTool={(toolId) => openTab(toolId)} categoryId={activeCategory} />
  }

  const toolDef = getTool(activeTab.toolId)

  return (
    <div className="flex h-full flex-col bg-bg-app">
      {/* 工具栏:固定 60px 高,与 IconRail/TabSidebar 顶栏对齐,可拖拽移动窗口 */}
      <div className="drag flex h-[60px] items-center gap-2 border-b border-line bg-bg-surface px-4 pt-7">
        {/* 后退 / 前进:导航历史,放在工具名左侧 */}
        <div className="flex items-center gap-0.5 no-drag">
          <button
            onClick={goBack}
            disabled={!canGoBack}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            title="后退 (⌘[)"
          >
            <BackIcon size={16} />
          </button>
          <button
            onClick={goForward}
            disabled={!canGoForward}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            title="前进 (⌘])"
          >
            <ForwardIcon size={16} />
          </button>
        </div>
        {/* 分隔线:导航区与工具名之间 */}
        <div className="h-4 w-px bg-line" />
        <span className="text-page text-ink-primary">{toolDef?.name ?? activeTab.toolId}</span>
        {activeTab.groupId && (
          <span className="text-caption text-ink-tertiary">
            {groups.find((g) => g.id === activeTab.groupId)?.name ?? ''}
          </span>
        )}
        <div className="ml-auto flex gap-1.5 no-drag">
          <ToolBtn onClick={() => duplicateTab(activeTab.id)}>
            复制此页
          </ToolBtn>
          <ToolBtn onClick={handleFavTab}>★ 收藏此页</ToolBtn>
          <ToolBtn onClick={handleFavGroup} disabled={!activeTab.groupId}>
            ★ 收藏当前分组
          </ToolBtn>
        </div>
      </div>

      {/* 工具内容:keep-alive —— 所有已打开标签都挂载,用显隐切换,保留各工具内部状态(模式/光标/滚动等) */}
      <div className="relative flex-1 overflow-hidden">
        {tabs.map((t) => {
          const Comp = loadTool(t.toolId)
          if (!Comp) return null
          return (
            <div
              key={t.id}
              className="absolute inset-0 overflow-auto"
              style={{ display: t.id === activeTabId ? 'block' : 'none' }}
            >
              <Suspense fallback={<div className="p-4 text-caption text-ink-tertiary">加载中…</div>}>
                <Comp
                  input={t.state.input}
                  onInput={(v) => setTabInput(t.id, v)}
                  config={t.state.config}
                />
              </Suspense>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ToolBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover hover:text-ink-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

function EmptyState({
  onOpenTool,
  categoryId,
}: {
  onOpenTool: (toolId: string) => void
  categoryId: string | null
}) {
  const [selCat, setSelCat] = useState<string | null>(categoryId)
  useEffect(() => setSelCat(categoryId), [categoryId])
  const canGoBack = useAppStore((s) => s.canGoBack())
  const canGoForward = useAppStore((s) => s.canGoForward())
  const goBack = useAppStore((s) => s.goBack)
  const goForward = useAppStore((s) => s.goForward)

  const tools = TOOLS.filter((t) => !selCat || t.categoryId === selCat)

  return (
    <div className="flex h-full flex-col bg-bg-app">
      <div className="drag flex h-[60px] items-center gap-2 border-b border-line bg-bg-surface px-4 pt-7">
        {/* 后退 / 前进 */}
        <div className="flex items-center gap-0.5 no-drag">
          <button
            onClick={goBack}
            disabled={!canGoBack}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            title="后退 (⌘[)"
          >
            <BackIcon size={16} />
          </button>
          <button
            onClick={goForward}
            disabled={!canGoForward}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            title="前进 (⌘])"
          >
            <ForwardIcon size={16} />
          </button>
        </div>
        <div className="h-4 w-px bg-line" />
        <span className="text-page text-ink-primary">RainTool</span>
      </div>
      <div className="flex flex-1 overflow-auto p-6">
        <div className="mx-auto w-full max-w-3xl">
          {/* 分类筛选 */}
          <div className="mb-5 flex flex-wrap gap-1.5">
            <CatChip active={!selCat} onClick={() => setSelCat(null)}>
              全部
            </CatChip>
            {CATEGORIES.map((c) => (
              <CatChip key={c.id} active={selCat === c.id} onClick={() => setSelCat(c.id)}>
                {c.name}
              </CatChip>
            ))}
          </div>

          {/* 工具列表 */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {tools.map((t) => {
              const cat = CATEGORIES.find((c) => c.id === t.categoryId)
              return (
                <button
                  key={t.id}
                  onClick={() => onOpenTool(t.id)}
                  className="rounded-card border border-line bg-bg-surface p-3 text-left hover:border-line-strong hover:bg-bg-hover"
                >
                  <div className="text-body text-ink-primary">{t.name}</div>
                  <div className="mt-0.5 text-caption text-ink-tertiary">{cat?.name}</div>
                </button>
              )
            })}
          </div>

          {tools.length === 0 && (
            <div className="mt-12 text-center text-caption text-ink-tertiary">
              该分类暂无工具
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CatChip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-caption ${
        active ? 'bg-accent-bg text-accent' : 'bg-bg-subtle text-ink-secondary hover:bg-bg-hover'
      }`}
    >
      {children}
    </button>
  )
}
