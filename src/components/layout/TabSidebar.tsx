import { useState, type DragEvent } from 'react'
import { useAppStore, type Tab, type TabGroup, type GroupColor } from '@/store/tabs'
import { useUIStore } from '@/store/ui'
import { TOOLS } from '../tools/catalog'
import { PlusIcon, CloseIcon, ChevronDownIcon, ChevronRightIcon, ExpandIcon } from '../icons'

// 莫兰迪色映射
const GROUP_COLORS: Record<GroupColor, string> = {
  1: 'bg-group-1',
  2: 'bg-group-2',
  3: 'bg-group-3',
  4: 'bg-group-4',
  5: 'bg-group-5',
  6: 'bg-group-6',
}

export function TabSidebar() {
  const collapsed = useUIStore((s) => s.tabSidebarCollapsed)
  const toggle = useUIStore((s) => s.toggleTabSidebar)

  if (collapsed) {
    return <CollapsedRail count={useAppStore.getState().tabs.length} onExpand={toggle} />
  }

  return <ExpandedSidebar />
}

function CollapsedRail({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <div className="flex h-full w-5 flex-col items-center justify-center border-r border-line bg-bg-surface">
      <button
        onClick={onExpand}
        className="flex flex-col items-center gap-2 text-ink-tertiary hover:text-ink-secondary"
        title="展开标签栏"
      >
        <ExpandIcon size={14} />
        <span className="text-label" style={{ writingMode: 'vertical-rl' }}>
          标签页 ({count})
        </span>
      </button>
    </div>
  )
}

function ExpandedSidebar() {
  const tabs = useAppStore((s) => s.tabs)
  const groups = useAppStore((s) => s.groups)
  const createGroup = useAppStore((s) => s.createGroup)
  const toggle = useUIStore((s) => s.toggleTabSidebar)

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ type: 'group' | 'tab'; id: string; x: number; y: number } | null>(
    null,
  )

  const toggleGroup = (id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // 未分组的标签
  const ungroupedTabs = tabs.filter((t) => !t.groupId)
  const sortedGroups = [...groups].sort((a, b) => a.order - b.order)

  return (
    <div className="flex h-full w-56 flex-col border-r border-line bg-bg-surface">
      {/* 顶部 */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-page text-ink-primary">标签页</span>
        <button
          onClick={toggle}
          className="rounded-btn px-1 text-ink-tertiary hover:bg-bg-hover hover:text-ink-secondary"
          title="收起"
        >
          <ChevronRightIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {/* 各分组 */}
        {sortedGroups.map((g) => (
          <GroupSection
            key={g.id}
            group={g}
            tabs={tabs.filter((t) => t.groupId === g.id)}
            collapsed={collapsedGroups.has(g.id)}
            onToggle={() => toggleGroup(g.id)}
            onMenuGroup={(e) => setMenu({ type: 'group', id: g.id, x: e.clientX, y: e.clientY })}
            onMenuTab={(e, tabId) => setMenu({ type: 'tab', id: tabId, x: e.clientX, y: e.clientY })}
          />
        ))}

        {/* 未分组 */}
        {ungroupedTabs.length > 0 && (
          <div className="mt-2">
            <div className="px-2 py-1 text-label text-ink-tertiary">未分组</div>
            {ungroupedTabs.map((t) => (
              <TabItem
                key={t.id}
                tab={t}
                onMenu={(e) => setMenu({ type: 'tab', id: t.id, x: e.clientX, y: e.clientY })}
              />
            ))}
          </div>
        )}

        {tabs.length === 0 && (
          <div className="mt-8 px-3 text-center text-caption text-ink-tertiary">
            暂无标签页
            <br />
            从左侧选择工具类型
          </div>
        )}
      </div>

      {/* 底部:新建分组 */}
      <div className="border-t border-line px-2 py-2">
        <button
          onClick={() => createGroup('新分组')}
          className="flex w-full items-center gap-1.5 rounded-btn px-2 py-1.5 text-caption text-ink-secondary hover:bg-bg-hover"
        >
          <PlusIcon size={12} /> 新建分组
        </button>
      </div>

      {/* 右键菜单 */}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          {menu.type === 'group' ? (
            <GroupMenu menu={menu} onClose={() => setMenu(null)} />
          ) : (
            <TabMenu menu={menu} onClose={() => setMenu(null)} />
          )}
        </>
      )}
    </div>
  )
}

function GroupSection({
  group,
  tabs,
  collapsed,
  onToggle,
  onMenuGroup,
  onMenuTab,
}: {
  group: TabGroup
  tabs: Tab[]
  collapsed: boolean
  onToggle: () => void
  onMenuGroup: (e: React.MouseEvent) => void
  onMenuTab: (e: React.MouseEvent, tabId: string) => void
}) {
  const moveTabToGroup = useAppStore((s) => s.moveTabToGroup)

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const tabId = e.dataTransfer.getData('text/tab-id')
    if (tabId) moveTabToGroup(tabId, group.id)
  }
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
  }

  return (
    <div
      className="mb-1"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div
        onClick={onToggle}
        onContextMenu={onMenuGroup}
        className="group flex cursor-pointer items-center gap-1.5 rounded-btn px-2 py-1 hover:bg-bg-hover"
        style={{ borderLeft: `2px solid var(--color-group-${group.color})` }}
      >
        {collapsed ? <ChevronRightIcon size={11} /> : <ChevronDownIcon size={11} />}
        <span className={`h-2 w-2 rounded-full ${GROUP_COLORS[group.color]}`} />
        <span className="flex-1 truncate text-label text-ink-secondary">{group.name}</span>
        <span className="text-label text-ink-tertiary">{tabs.length}</span>
      </div>
      {!collapsed &&
        tabs.map((t) => (
          <TabItem
            key={t.id}
            tab={t}
            onMenu={(e) => { e.stopPropagation(); onMenuTab(e, t.id) }}
          />
        ))}
    </div>
  )
}

// TabItem 接收 onMenu:右键弹自己的菜单
function TabItem({
  tab,
  onMenu,
}: {
  tab: Tab
  onMenu: (e: React.MouseEvent) => void
}) {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const closeTab = useAppStore((s) => s.closeTab)

  const active = activeTabId === tab.id
  const tool = TOOLS.find((t) => t.id === tab.toolId)
  const title = tab.title || tool?.name || tab.toolId

  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer.setData('text/tab-id', tab.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={() => setActiveTab(tab.id)}
      onContextMenu={onMenu}
      className={`group flex cursor-pointer items-center gap-1.5 rounded-btn py-1 pl-6 pr-2 text-body ${
        active ? 'bg-accent-bg text-accent' : 'text-ink-secondary hover:bg-bg-hover'
      }`}
    >
      <span className="flex-1 truncate">{title}</span>
      {tab.state.pinned && <span className="text-ink-tertiary">●</span>}
      <button
        onClick={(e) => {
          e.stopPropagation()
          closeTab(tab.id)
        }}
        className="opacity-0 transition-opacity group-hover:opacity-100"
      >
        <CloseIcon />
      </button>
    </div>
  )
}

// 组标题右键菜单
function GroupMenu({ menu, onClose }: { menu: { id: string; x: number; y: number }; onClose: () => void }) {
  const groups = useAppStore((s) => s.groups)
  const renameGroup = useAppStore((s) => s.renameGroup)
  const setGroupColor = useAppStore((s) => s.setGroupColor)
  const ungroup = useAppStore((s) => s.ungroup)
  const closeGroupTabs = useAppStore((s) => s.closeGroupTabs)
  const deleteGroup = useAppStore((s) => s.deleteGroup)

  const group = groups.find((g) => g.id === menu.id)
  const [name, setName] = useState(group?.name ?? '')

  if (!group) return null

  const colors: GroupColor[] = [1, 2, 3, 4, 5, 6]

  return (
    <div
      className="fixed z-50 w-52 overflow-hidden rounded-card border border-line-strong bg-bg-surface shadow-float"
      style={{ left: menu.x, top: menu.y }}
    >
      <div className="border-b border-line p-2.5">
        <div className="mb-1.5 text-label text-ink-tertiary">分组名称</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => renameGroup(group.id, name)}
          className="w-full rounded-btn border border-line-strong bg-bg-subtle px-2 py-1 text-body text-ink-primary outline-none focus:border-accent"
        />
      </div>
      <div className="border-b border-line p-2.5">
        <div className="mb-1.5 text-label text-ink-tertiary">标签颜色</div>
        <div className="flex gap-1.5">
          {colors.map((c) => (
            <button
              key={c}
              onClick={() => setGroupColor(group.id, c)}
              className={`h-4 w-4 rounded-full ${GROUP_COLORS[c]} ${
                group.color === c ? 'ring-1 ring-offset-1 ring-accent' : ''
              }`}
            />
          ))}
        </div>
      </div>
      <div className="p-1">
        <MenuBtn onClick={() => { ungroup(group.id); onClose() }}>解散标签组</MenuBtn>
        <MenuBtn danger onClick={() => { closeGroupTabs(group.id); deleteGroup(group.id); onClose() }}>
          关闭并删除
        </MenuBtn>
      </div>
    </div>
  )
}

// 组内标签右键菜单
function TabMenu({ menu, onClose }: { menu: { id: string; x: number; y: number }; onClose: () => void }) {
  const tabs = useAppStore((s) => s.tabs)
  const groups = useAppStore((s) => s.groups)
  const duplicateTab = useAppStore((s) => s.duplicateTab)
  const togglePin = useAppStore((s) => s.togglePin)
  const moveTabToGroup = useAppStore((s) => s.moveTabToGroup)
  const closeTab = useAppStore((s) => s.closeTab)

  const tab = tabs.find((t) => t.id === menu.id)
  if (!tab) return null

  return (
    <div
      className="fixed z-50 w-48 overflow-hidden rounded-card border border-line-strong bg-bg-surface shadow-float"
      style={{ left: menu.x, top: menu.y }}
    >
      <div className="p-1">
        <MenuBtn onClick={() => { duplicateTab(tab.id); onClose() }}>复制此页</MenuBtn>
        <MenuBtn onClick={() => { togglePin(tab.id); onClose() }}>
          {tab.state.pinned ? '取消固定' : '固定标签页'}
        </MenuBtn>
        <div className="my-1 h-px bg-line" />
        <div className="group relative">
          <MenuBtn>移动到分组 ›</MenuBtn>
          <div className="absolute left-full top-0 w-40 rounded-card border border-line-strong bg-bg-surface shadow-float">
            <MenuBtn onClick={() => { moveTabToGroup(tab.id, null); onClose() }}>移出当前组</MenuBtn>
            <div className="my-1 h-px bg-line" />
            {groups
              .filter((g) => g.id !== tab.groupId)
              .map((g) => (
                <MenuBtn key={g.id} onClick={() => { moveTabToGroup(tab.id, g.id); onClose() }}>
                  <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${GROUP_COLORS[g.color]}`} />
                  {g.name}
                </MenuBtn>
              ))}
          </div>
        </div>
        <div className="my-1 h-px bg-line" />
        <MenuBtn danger onClick={() => { closeTab(tab.id); onClose() }}>关闭标签页</MenuBtn>
      </div>
    </div>
  )
}

function MenuBtn({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode
  onClick?: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded-btn px-2.5 py-1.5 text-left text-body hover:bg-bg-hover ${
        danger ? 'text-danger' : 'text-ink-primary'
      }`}
    >
      {children}
    </button>
  )
}
