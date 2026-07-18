import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType } from 'react'
import { useAppStore } from '@/store/tabs'
import { useUIStore } from '@/store/ui'
import { useFavoritesStore, snapshotTab, snapshotGroup } from '@/store/favorites'
import { TOOLS, getTool, CATEGORIES } from '../tools/catalog'
import { ToolErrorBoundary } from '../tools/ErrorBoundary'
import type { ToolProps } from '../tools/shared'

// 懒加载工具组件。
//
// P0-2 修复：此前每个标签页的 <Suspense fallback="加载中…"> 没有外层
// ErrorBoundary。一旦某个工具的动态 chunk 加载失败（打包后缺 chunk、
// Monaco worker 解析失败、网络抖动等），lazy() 抛出的 rejection 没有边界
// 捕获，React 会把这个标签页永久留在 Suspense fallback 上 —— 用户看到的是
// 一直「加载中…」且无任何重试入口（Git 工作台首屏即典型受害方）。
//
// 现在 TabBoundary 包裹每个标签：lazy 抛出的错误被 ToolErrorBoundary 捕获，
// 渲染「重试」按钮。点击重试时清掉该工具的缓存并 bump 一个 key，loadTool
// 重新创建 lazy（重新发起动态 import），React 重新挂载子树。这样首屏 Monaco
// 阻塞或 chunk 缺失都不会让标签页永久卡死，且给出可重试的可见错误。
const toolCache = new Map<string, ComponentType<ToolProps>>()
function loadTool(toolId: string) {
  if (toolCache.has(toolId)) return toolCache.get(toolId)!
  const def = getTool(toolId)
  if (!def) return null
  const Comp = lazy(() => def.loader().then((m) => ({ default: m.default })))
  toolCache.set(toolId, Comp)
  return Comp
}

/**
 * 单个标签页的Suspense + ErrorBoundary 容器。retry 时清缓存 + bump key，
 * 强制 loadTool 重新发起动态 import（Vite 的 import() 失败后 Promise 会
 * 一直 rejected，不清缓存重试只是复用同一个 rejected promise）。
 */
function TabBoundary({ toolId, children }: { toolId: string; children: React.ReactNode }) {
  const [retryKey, setRetryKey] = useState(0)
  const handleRetry = useCallback(() => {
    toolCache.delete(toolId)
    setRetryKey((k) => k + 1)
  }, [toolId])
  return (
    <ToolErrorBoundary
      key={retryKey}
      label="工具"
      recoverHint="该工具加载失败，可重试；若多次失败，请重启 RainTool 后再试。"
      onRetry={handleRetry}
    >
      <Suspense fallback={<div className="p-4 text-caption text-ink-tertiary">加载中…</div>}>
        {children}
      </Suspense>
    </ToolErrorBoundary>
  )
}

export function Workspace() {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const tabs = useAppStore((s) => s.tabs)
  const groups = useAppStore((s) => s.groups)
  const openTab = useAppStore((s) => s.openTab)
  const setTabInput = useAppStore((s) => s.setTabInput)
  const setTabDiffLeft = useAppStore((s) => s.setTabDiffLeft)
  const setTabDiffRight = useAppStore((s) => s.setTabDiffRight)
  const setTabConfig = useAppStore((s) => s.setTabConfig)
  const setTabDiagramId = useAppStore((s) => s.setTabDiagramId)
  const duplicateTab = useAppStore((s) => s.duplicateTab)
  const activeCategory = useUIStore((s) => s.activeCategory)
  const addFavTab = useFavoritesStore((s) => s.addTab)
  const addFavGroup = useFavoritesStore((s) => s.addGroup)
  const favoriteItems = useFavoritesStore((s) => s.items)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeTabIsFavorite = Boolean(activeTab && favoriteItems.some((item) => {
    if (item.kind !== 'tab' || !item.tab) return false
    if (activeTab.state.diagramId) return item.tab.diagramId === activeTab.state.diagramId
    return item.tab.toolId === activeTab.toolId && item.tab.title === activeTab.title && item.tab.input === activeTab.state.input
  }))

  useEffect(() => {
    const diagramId = activeTab?.toolId === 'ai-drawio' ? activeTab.state.diagramId ?? null : null
    void window.raintool.setActiveDiagram(diagramId)
  }, [activeTab?.toolId, activeTab?.state.diagramId])

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
        <span className="text-page text-ink-primary">{toolDef?.name ?? activeTab.toolId}</span>
        {activeTab.groupId && (
          <span className="text-caption text-ink-tertiary">
            {groups.find((g) => g.id === activeTab.groupId)?.name ?? ''}
          </span>
        )}
        {activeTab.toolId !== 'diagram-manager' && (
          <div className="ml-auto flex gap-1.5 no-drag">
            <ToolBtn onClick={() => void duplicateTab(activeTab.id)}>
              复制此页
            </ToolBtn>
            <ToolBtn onClick={handleFavTab}>{activeTabIsFavorite ? '★ 已收藏' : '★ 收藏此页'}</ToolBtn>
            <ToolBtn onClick={handleFavGroup} disabled={!activeTab.groupId}>
              ★ 收藏当前分组
            </ToolBtn>
          </div>
        )}
      </div>

      {/* 工具内容:keep-alive —— 所有已打开标签都挂载,用显隐切换,保留各工具内部状态(模式/光标/滚动等) */}
      <div className="relative flex-1 overflow-hidden">
        {tabs.map((t) => {
          const Comp = loadTool(t.toolId)
          if (!Comp) return null
          return (
            <div
              key={t.id}
              className={`absolute inset-0 ${t.toolId === 'ai-drawio' ? 'overflow-hidden' : 'overflow-auto'}`}
              style={{ display: t.id === activeTabId ? 'block' : 'none' }}
            >
              <TabBoundary toolId={t.toolId}>
                <Comp
                  tabId={t.id}
                  input={t.state.input}
                  onInput={(v) => setTabInput(t.id, v)}
                  config={t.state.config}
                  onConfig={(config) => setTabConfig(t.id, config)}
                  diffLeft={t.state.diffLeft}
                  diffRight={t.state.diffRight}
                  onDiffLeft={(v) => setTabDiffLeft(t.id, v)}
                  onDiffRight={(v) => setTabDiffRight(t.id, v)}
                  diagramId={t.state.diagramId}
                  onDiagramId={(diagramId, title) => setTabDiagramId(t.id, diagramId, title)}
                />
              </TabBoundary>
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

  const tools = TOOLS.filter((t) => !selCat || t.categoryId === selCat)

  return (
    <div className="flex h-full flex-col bg-bg-app">
      <div className="drag flex h-[60px] items-center border-b border-line bg-bg-surface px-4 pt-7">
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
