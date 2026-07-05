import { useState, type DragEvent } from 'react'
import { useAppStore, type Tab, type TabGroup, type GroupColor } from '@/store/tabs'
import { useUIStore } from '@/store/ui'
import { useFavoritesStore, snapshotTab, snapshotGroup } from '@/store/favorites'
import { getTool, TOOLS, CATEGORIES } from '../tools/catalog'
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
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/group-id', group.id)
          e.dataTransfer.effectAllowed = 'copy'
        }}
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

// TabItem 接收 onMenu:右键弹自己的菜单;双击可重命名
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
  const renameTab = useAppStore((s) => s.renameTab)

  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState('')

  const active = activeTabId === tab.id
  const tool = TOOLS.find((t) => t.id === tab.toolId)
  const title = tab.title || tool?.name || tab.toolId

  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer.setData('text/tab-id', tab.id)
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  const startEdit = () => {
    setVal(tab.title || '')
    setEditing(true)
  }
  const commitEdit = () => {
    renameTab(tab.id, val.trim())
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 rounded-btn py-1 pl-6 pr-2">
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            if (e.key === 'Escape') setEditing(false)
          }}
          placeholder={tool?.name}
          className="flex-1 rounded-btn border border-accent bg-bg-subtle px-1.5 py-0.5 text-body text-ink-primary outline-none"
        />
      </div>
    )
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={() => setActiveTab(tab.id)}
      onDoubleClick={(e) => { e.stopPropagation(); startEdit() }}
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
  const allTabs = useAppStore((s) => s.tabs)
  const renameGroup = useAppStore((s) => s.renameGroup)
  const setGroupColor = useAppStore((s) => s.setGroupColor)
  const ungroup = useAppStore((s) => s.ungroup)
  const closeGroupTabs = useAppStore((s) => s.closeGroupTabs)
  const deleteGroup = useAppStore((s) => s.deleteGroup)
  const openTab = useAppStore((s) => s.openTab)
  const addFavGroup = useFavoritesStore((s) => s.addGroup)

  const group = groups.find((g) => g.id === menu.id)
  const [name, setName] = useState(group?.name ?? '')

  if (!group) return null

  const colors: GroupColor[] = [1, 2, 3, 4, 5, 6]

  // 在组内添加新标签:展开工具选择
  const handleAddTool = (toolId: string) => {
    openTab(toolId, undefined, group.id)
    onClose()
  }

  // 收藏此分组(整组快照)
  const handleFavGroup = () => {
    addFavGroup(group.name, snapshotGroup(group, allTabs))
    onClose()
  }

  return (
    <div
      className="fixed z-50 w-56 overflow-hidden rounded-card border border-line-strong bg-bg-surface shadow-float"
      style={{ left: menu.x, top: menu.y, maxHeight: '70vh', overflowY: 'auto' }}
    >
      <div className="border-b border-line p-2.5">
        <div className="mb-1.5 text-label text-ink-tertiary">分组名称</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => renameGroup(group.id, name)}
          onKeyDown={(e) => { if (e.key === 'Enter') renameGroup(group.id, name) }}
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
      {/* 在组内添加新标签:可选任意工具 */}
      <div className="border-b border-line p-2">
        <div className="mb-1.5 text-label text-ink-tertiary">在组内添加标签</div>
        <div className="flex flex-col gap-0.5">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => handleAddTool(t.id)}
              className="flex items-center gap-1.5 rounded-btn px-2 py-1 text-left text-caption text-ink-secondary hover:bg-bg-hover hover:text-ink-primary"
            >
              <span className="text-ink-tertiary">+</span>
              <span className="flex-1">{t.name}</span>
              <span className="text-label text-ink-tertiary">
                {CATEGORIES.find((c) => c.id === t.categoryId)?.name}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="p-1">
        <MenuBtn onClick={handleFavGroup}>★ 收藏此分组</MenuBtn>
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
  const renameTab = useAppStore((s) => s.renameTab)
  const openTab = useAppStore((s) => s.openTab)
  const createGroup = useAppStore((s) => s.createGroup)

  const tab = tabs.find((t) => t.id === menu.id)
  const [renameMode, setRenameMode] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [newGroupMode, setNewGroupMode] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [showAddBelow, setShowAddBelow] = useState(false)
  const [showMoveTo, setShowMoveTo] = useState(false)

  const addFavTab = useFavoritesStore((s) => s.addTab)

  if (!tab) return null

  const tool = getTool(tab.toolId)
  const defaultTitle = tool?.name ?? tab.toolId

  // 收藏此标签(单标签快照)
  const handleFavTab = () => {
    addFavTab(tab.title || defaultTitle, snapshotTab(tab))
    onClose()
  }

  const startRename = () => {
    setRenameVal(tab.title || defaultTitle)
    setRenameMode(true)
  }
  const commitRename = () => {
    renameTab(tab.id, renameVal.trim() || defaultTitle)
    setRenameMode(false)
  }

  // 移动到新建分组:命名后创建并移动
  const commitNewGroup = () => {
    const name = newGroupName.trim() || '新分组'
    const gid = createGroup(name)
    moveTabToGroup(tab.id, gid)
    setNewGroupMode(false)
    setNewGroupName('')
    onClose()
  }

  // 在当前标签下方新建标签(复用当前标签的分组)
  const handleAddBelow = (toolId: string) => {
    openTab(toolId, undefined, tab.groupId)
    setShowAddBelow(false)
    onClose()
  }

  const otherGroups = groups.filter((g) => g.id !== tab.groupId)

  return (
    <div
      className="fixed z-50 w-52 overflow-hidden rounded-card border border-line-strong bg-bg-surface shadow-float"
      style={{ left: menu.x, top: menu.y, maxHeight: '75vh', overflowY: 'auto' }}
    >
      <div className="p-1">
        {/* 重命名:行内输入 */}
        {renameMode ? (
          <div className="px-1 pb-1">
            <div className="mb-1 text-label text-ink-tertiary">重命名</div>
            <input
              autoFocus
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setRenameMode(false)
              }}
              className="w-full rounded-btn border border-accent bg-bg-subtle px-2 py-1 text-body text-ink-primary outline-none"
            />
          </div>
        ) : (
          <MenuBtn onClick={startRename}>✏️ 重命名</MenuBtn>
        )}
        <MenuBtn onClick={() => { duplicateTab(tab.id); onClose() }}>复制此页</MenuBtn>
        <MenuBtn onClick={handleFavTab}>★ 收藏此标签</MenuBtn>
        <MenuBtn onClick={() => { togglePin(tab.id); onClose() }}>
          {tab.state.pinned ? '取消固定' : '固定标签页'}
        </MenuBtn>
        <div className="my-1 h-px bg-line" />
        {/* 在此下方新建标签(可选任意工具,复用当前分组) */}
        {showAddBelow ? (
          <div className="px-1 pb-1">
            <div className="mb-1 text-label text-ink-tertiary">选择工具</div>
            <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => handleAddBelow(t.id)}
                  className="flex items-center gap-1.5 rounded-btn px-2 py-1 text-left text-caption text-ink-secondary hover:bg-bg-hover hover:text-ink-primary"
                >
                  <span className="text-ink-tertiary">+</span>
                  <span className="flex-1">{t.name}</span>
                  <span className="text-label text-ink-tertiary">
                    {CATEGORIES.find((c) => c.id === t.categoryId)?.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <MenuBtn onClick={() => setShowAddBelow(true)}>在下方新建标签 ›</MenuBtn>
        )}
        <div className="my-1 h-px bg-line" />
        {/* 移动到分组:始终含「新建分组」,无分组时也能用 */}
        {newGroupMode ? (
          <div className="px-1 pb-1">
            <div className="mb-1 text-label text-ink-tertiary">新分组名称</div>
            <input
              autoFocus
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onBlur={commitNewGroup}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNewGroup()
                if (e.key === 'Escape') setNewGroupMode(false)
              }}
              placeholder="输入分组名"
              className="w-full rounded-btn border border-accent bg-bg-subtle px-2 py-1 text-body text-ink-primary outline-none"
            />
          </div>
        ) : showMoveTo ? (
          <div className="px-1 pb-1">
            <div className="mb-1 text-label text-ink-tertiary">移动到分组</div>
            <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              <MenuBtn onClick={() => { moveTabToGroup(tab.id, null); onClose() }}>移出当前组</MenuBtn>
              <MenuBtn onClick={() => setNewGroupMode(true)}>
                <span className="text-accent">+ 新建分组…</span>
              </MenuBtn>
              {otherGroups.length > 0 && <div className="my-1 h-px bg-line" />}
              {otherGroups.map((g) => (
                <MenuBtn key={g.id} onClick={() => { moveTabToGroup(tab.id, g.id); onClose() }}>
                  <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${GROUP_COLORS[g.color]}`} />
                  {g.name}
                </MenuBtn>
              ))}
            </div>
          </div>
        ) : (
          <MenuBtn onClick={() => setShowMoveTo(true)}>移动到分组 ›</MenuBtn>
        )}
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
