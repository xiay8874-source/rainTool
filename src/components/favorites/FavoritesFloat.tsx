import { useRef, useState, type DragEvent as RDragEvent, type MouseEvent } from 'react'
import { useUIStore } from '@/store/ui'
import { useFavoritesStore, snapshotTab, snapshotGroup } from '@/store/favorites'
import { useAppStore } from '@/store/tabs'
import { getTool } from '../tools/catalog'
import { StarIcon, CloseIcon, PlusIcon } from '../icons'

export function FavoritesFloat() {
  const open = useUIStore((s) => s.favoritesOpen)
  const setOpen = useUIStore((s) => s.setFavoritesOpen)
  const rect = useUIStore((s) => s.favoritesRect)

  if (!open) return null

  return (
    <div
      className="absolute z-30 flex flex-col overflow-hidden rounded-card border border-line-strong bg-bg-surface shadow-float"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
      }}
    >
      <DragHeader />
      <SearchBar />
      <FavoritesList />
      <Footer />
      {/* 关闭按钮 */}
      <button
        onClick={() => setOpen(false)}
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-btn text-ink-tertiary hover:bg-bg-hover"
      >
        <CloseIcon size={12} />
      </button>
    </div>
  )
}

function DragHeader() {
  const rect = useUIStore((s) => s.favoritesRect)
  const setRect = useUIStore((s) => s.setFavoritesRect)
  const dragging = useRef<{ ox: number; oy: number } | null>(null)
  const count = useFavoritesStore((s) => s.items.length)

  const onDown = (e: MouseEvent) => {
    dragging.current = { ox: e.clientX - rect.x, oy: e.clientY - rect.y }
    const move = (ev: globalThis.MouseEvent) => {
      if (!dragging.current) return
      setRect({ x: ev.clientX - dragging.current.ox, y: ev.clientY - dragging.current.oy })
    }
    const up = () => {
      dragging.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    e.stopPropagation()
  }

  return (
    <div
      onMouseDown={onDown}
      className="flex cursor-move items-center gap-1.5 border-b border-line px-3 py-2"
      style={{ background: 'linear-gradient(180deg,#fff,#fafbfc)' }}
    >
      <StarIcon size={13} className="text-ink-tertiary" />
      <span className="text-body text-ink-primary">收藏夹</span>
      <span className="rounded-full bg-bg-subtle px-1.5 text-label text-ink-tertiary">{count}</span>
    </div>
  )
}

function SearchBar() {
  const [q, setQ] = useState('')
  return (
    <div className="border-b border-line px-2.5 py-1.5">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索收藏…"
        className="w-full rounded-btn bg-bg-subtle px-2 py-1 text-caption text-ink-primary outline-none placeholder:text-ink-tertiary"
      />
      {/* 搜索词暂存到全局,简单起见用 data 属性透传 */}
      <SearchBridge q={q} />
    </div>
  )
}

// 用一个隐藏元素把搜索词透传给列表(避免提升状态层级)
let _searchQ = ''
function SearchBridge({ q }: { q: string }) {
  _searchQ = q
  return null
}

function FavoritesList() {
  const items = useFavoritesStore((s) => s.items)
  const folders = useFavoritesStore((s) => s.folders)
  const remove = useFavoritesStore((s) => s.remove)
  const restoreTab = useFavoritesStore((s) => s.restoreTab)
  const restoreGroup = useFavoritesStore((s) => s.restoreGroup)
  const addTab = useFavoritesStore((s) => s.addTab)
  const addGroup = useFavoritesStore((s) => s.addGroup)
  const moveToFolder = useFavoritesStore((s) => s.moveToFolder)
  const createFolder = useFavoritesStore((s) => s.createFolder)

  // 右键菜单:移动到文件夹
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [newFolderMode, setNewFolderMode] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  const openTab = useAppStore((s) => s.openTab)
  const openDiagramTab = useAppStore((s) => s.openDiagramTab)
  const setTabInput = useAppStore((s) => s.setTabInput)
  const createGroup = useAppStore((s) => s.createGroup)
  const moveTabToGroup = useAppStore((s) => s.moveTabToGroup)
  const allTabs = useAppStore((s) => s.tabs)
  const allGroups = useAppStore((s) => s.groups)

  // 拖拽高亮:哪个区域正在悬停(null=根区域, 'folder:<id>'=某文件夹)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const q = _searchQ.toLowerCase()
  const filtered = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items

  const grouped = folders.map((f) => ({
    folder: f,
    items: filtered.filter((i) => i.folderId === f.id),
  }))
  const unfiled = filtered.filter((i) => !i.folderId)

  // 恢复单个标签:打开工具 + 回写保存的输入内容
  const handleRestoreTab = (id: string) => {
    const t = restoreTab(id)
    if (!t) return
    const tabId = t.toolId === 'ai-drawio' && t.diagramId
      ? openDiagramTab(t.diagramId, t.title)
      : openTab(t.toolId, t.title)
    if (t.input) setTabInput(tabId, t.input)
  }

  // 恢复整组:建组 + 逐个开标签(带回输入) + 移入组
  const handleRestoreGroup = (id: string) => {
    const g = restoreGroup(id)
    if (!g) return
    const gid = createGroup(g.name)
    g.tabs.forEach((t) => {
      const tabId = t.toolId === 'ai-drawio' && t.diagramId
        ? openDiagramTab(t.diagramId, t.title)
        : openTab(t.toolId, t.title)
      if (t.input) setTabInput(tabId, t.input)
      moveTabToGroup(tabId, gid)
    })
  }

  // 拖拽收藏:从标签栏拖入的标签(tab-id)或整组(group-id)
  const handleDrop = (e: RDragEvent, folderId: string | null) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const tabId = e.dataTransfer.getData('text/tab-id')
    const groupId = e.dataTransfer.getData('text/group-id')
    if (tabId) {
      const tab = allTabs.find((t) => t.id === tabId)
      if (!tab) return
      const tool = getTool(tab.toolId)
      addTab(tab.title || tool?.name || tab.toolId, snapshotTab(tab), folderId)
    } else if (groupId) {
      const group = allGroups.find((g) => g.id === groupId)
      if (!group) return
      addGroup(group.name, snapshotGroup(group, allTabs), folderId)
    }
  }

  const allowDrop = (e: RDragEvent, target: string) => {
    if (e.dataTransfer.types.includes('text/tab-id') || e.dataTransfer.types.includes('text/group-id')) {
      e.preventDefault()
      setDropTarget(target)
    }
  }

  return (
    <div
      className="flex-1 overflow-y-auto p-1.5"
      onDragOver={(e) => allowDrop(e, 'root')}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTarget(null) }}
      onDrop={(e) => handleDrop(e, null)}
      style={dropTarget === 'root' ? { background: 'var(--color-accent-bg)' } : undefined}
    >
      {/* 分组收藏 */}
      {grouped.map(({ folder, items: fItems }) =>
        fItems.length === 0 ? null : (
          <div key={folder.id} className="mb-2">
            <div
              onDragOver={(e) => allowDrop(e, `folder:${folder.id}`)}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => handleDrop(e, folder.id)}
              className={`px-1.5 py-1 text-label text-ink-tertiary ${dropTarget === `folder:${folder.id}` ? 'rounded-btn bg-accent-bg text-accent' : ''}`}
            >
              {folder.name}
            </div>
            {fItems.map((i) => (
              <FavRow
                key={i.id}
                item={i}
                onRestore={() => (i.kind === 'tab' ? handleRestoreTab(i.id) : handleRestoreGroup(i.id))}
                onRemove={() => remove(i.id)}
                onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ id: i.id, x: e.clientX, y: e.clientY }) }}
              />
            ))}
          </div>
        ),
      )}

      {/* 未归类 */}
      {unfiled.length > 0 && (
        <div>
          {grouped.length > 0 && <div className="px-1.5 py-1 text-label text-ink-tertiary">其他</div>}
          {unfiled.map((i) => (
            <FavRow
              key={i.id}
              item={i}
              onRestore={() => (i.kind === 'tab' ? handleRestoreTab(i.id) : handleRestoreGroup(i.id))}
              onRemove={() => remove(i.id)}
              onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ id: i.id, x: e.clientX, y: e.clientY }) }}
            />
          ))}
        </div>
      )}

      {filtered.length === 0 && (
        <div className="mt-8 text-center text-caption text-ink-tertiary">
          暂无收藏
          <br />
          在工作区点 ★ 收藏
        </div>
      )}

      {/* 右键菜单:移动到文件夹 */}
      {ctxMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => { setCtxMenu(null); setNewFolderMode(false) }} />
          <FavCtxMenu
            itemId={ctxMenu.id}
            x={ctxMenu.x}
            y={ctxMenu.y}
            folders={folders}
            newFolderMode={newFolderMode}
            newFolderName={newFolderName}
            onNewFolderName={setNewFolderName}
            onShowNewFolder={() => setNewFolderMode(true)}
            onCreateFolder={() => {
              const name = newFolderName.trim() || '新收藏夹'
              createFolder(name)
              setNewFolderName('')
              setNewFolderMode(false)
            }}
            onMove={(folderId) => { moveToFolder(ctxMenu.id, folderId); setCtxMenu(null); setNewFolderMode(false) }}
            onRemove={() => { remove(ctxMenu.id); setCtxMenu(null) }}
            onClose={() => { setCtxMenu(null); setNewFolderMode(false) }}
          />
        </>
      )}
    </div>
  )
}

function FavRow({
  item,
  onRestore,
  onRemove,
  onContextMenu,
}: {
  item: { id: string; kind: 'tab' | 'group'; name: string; group?: { tabs: unknown[] }; tab?: unknown }
  onRestore: () => void
  onRemove: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  return (
    <div
      onContextMenu={onContextMenu}
      className="group flex items-center gap-2 rounded-btn px-2 py-1.5 hover:bg-bg-hover"
    >
      <span className="flex-1 truncate text-body text-ink-primary">{item.name}</span>
      {item.kind === 'group' && (
        <span className="text-label text-ink-tertiary">{item.group?.tabs.length} 标签</span>
      )}
      <button
        onClick={onRestore}
        className="rounded-btn border border-line px-1.5 py-0.5 text-label text-ink-secondary hover:text-accent"
      >
        ↺ 恢复
      </button>
      <button
        onClick={onRemove}
        className="text-ink-tertiary opacity-0 hover:text-danger group-hover:opacity-100"
      >
        <CloseIcon size={11} />
      </button>
    </div>
  )
}

function Footer() {
  const createFolder = useFavoritesStore((s) => s.createFolder)
  return (
    <div className="flex items-center justify-between border-t border-line bg-bg-subtle px-2.5 py-1.5">
      <span className="text-label text-ink-tertiary">⌘B 唤起/收起 · 拖标题栏移动</span>
      <button
        onClick={() => createFolder('新收藏夹')}
        className="flex items-center gap-1 rounded-btn px-1.5 py-0.5 text-label text-ink-secondary hover:bg-bg-hover"
      >
        <PlusIcon size={11} /> 新建夹
      </button>
    </div>
  )
}

// 收藏项右键菜单:移入指定文件夹 / 新建文件夹 / 删除
function FavCtxMenu({
  itemId,
  x,
  y,
  folders,
  newFolderMode,
  newFolderName,
  onNewFolderName,
  onShowNewFolder,
  onCreateFolder,
  onMove,
  onRemove,
  onClose,
}: {
  itemId: string
  x: number
  y: number
  folders: { id: string; name: string }[]
  newFolderMode: boolean
  newFolderName: string
  onNewFolderName: (v: string) => void
  onShowNewFolder: () => void
  onCreateFolder: () => void
  onMove: (folderId: string | null) => void
  onRemove: () => void
  onClose: () => void
}) {
  void itemId
  return (
    <div
      className="fixed z-50 w-48 overflow-hidden rounded-card border border-line-strong bg-bg-surface shadow-float"
      style={{ left: x, top: y, maxHeight: '70vh', overflowY: 'auto' }}
    >
      {newFolderMode ? (
        <div className="p-2">
          <div className="mb-1 text-label text-ink-tertiary">新收藏夹名称</div>
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => onNewFolderName(e.target.value)}
            onBlur={onCreateFolder}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCreateFolder()
              if (e.key === 'Escape') onClose()
            }}
            placeholder="输入名称"
            className="w-full rounded-btn border border-accent bg-bg-subtle px-2 py-1 text-body text-ink-primary outline-none"
          />
        </div>
      ) : (
        <div className="p-1">
          <div className="px-2 py-1 text-label text-ink-tertiary">移入收藏夹</div>
          <CtxBtn onClick={() => onMove(null)}>未归类</CtxBtn>
          <CtxBtn onClick={onShowNewFolder}>
            <span className="text-accent">+ 新建收藏夹…</span>
          </CtxBtn>
          {folders.length > 0 && <div className="my-1 h-px bg-line" />}
          {folders.map((f) => (
            <CtxBtn key={f.id} onClick={() => onMove(f.id)}>{f.name}</CtxBtn>
          ))}
          <div className="my-1 h-px bg-line" />
          <CtxBtn danger onClick={onRemove}>删除收藏</CtxBtn>
        </div>
      )}
    </div>
  )
}

function CtxBtn({
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
