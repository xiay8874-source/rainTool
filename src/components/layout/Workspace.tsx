import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react'
import { useAppStore } from '@/store/tabs'
import { useUIStore } from '@/store/ui'
import { TOOLS, getTool, CATEGORIES } from '../tools/catalog'
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
  const activeCategory = useUIStore((s) => s.activeCategory)

  const activeTab = tabs.find((t) => t.id === activeTabId)

  // 无活动标签时,显示分类的工具选择面板
  if (!activeTab) {
    return <EmptyState onOpenTool={(toolId) => openTab(toolId)} categoryId={activeCategory} />
  }

  const toolDef = getTool(activeTab.toolId)
  const ToolComp = loadTool(activeTab.toolId)

  return (
    <div className="flex h-full flex-col bg-bg-app">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 border-b border-line bg-bg-surface px-4 py-2">
        <span className="text-page text-ink-primary">{toolDef?.name ?? activeTab.toolId}</span>
        {activeTab.groupId && (
          <span className="text-caption text-ink-tertiary">
            {groups.find((g) => g.id === activeTab.groupId)?.name ?? ''}
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          <ToolBtn onClick={() => duplicateTab(activeTab.id)}>
            复制此页
          </ToolBtn>
          <ToolBtn>★ 收藏此页</ToolBtn>
          <ToolBtn>★ 收藏当前分组</ToolBtn>
        </div>
      </div>

      {/* 工具内容 */}
      <div className="flex-1 overflow-auto">
        {ToolComp ? (
          <Suspense fallback={<div className="p-4 text-caption text-ink-tertiary">加载中…</div>}>
            <ToolComp
              input={activeTab.state.input}
              onInput={(v) => setTabInput(activeTab.id, v)}
              config={activeTab.state.config}
            />
          </Suspense>
        ) : (
          <div className="p-4 text-caption text-ink-tertiary">未知工具: {activeTab.toolId}</div>
        )}
      </div>
    </div>
  )
}

function ToolBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover hover:text-ink-primary"
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
      <div className="border-b border-line bg-bg-surface px-4 py-2">
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
