import { useRef, useState, type MouseEvent } from 'react'
import { useUIStore } from '@/store/ui'
import { useFavoritesStore } from '@/store/favorites'
import { useAppStore } from '@/store/tabs'
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
  const [count] = useState(useFavoritesStore.getState().items.length)

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

  const openTab = useAppStore((s) => s.openTab)
  const createGroup = useAppStore((s) => s.createGroup)
  const moveTabToGroup = useAppStore((s) => s.moveTabToGroup)

  const q = _searchQ.toLowerCase()
  const filtered = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items

  const grouped = folders.map((f) => ({
    folder: f,
    items: filtered.filter((i) => i.folderId === f.id),
  }))
  const unfiled = filtered.filter((i) => !i.folderId)

  const handleRestoreTab = (id: string) => {
    const t = restoreTab(id)
    if (t) openTab(t.toolId, t.title)
  }

  const handleRestoreGroup = (id: string) => {
    const g = restoreGroup(id)
    if (!g) return
    const gid = createGroup(g.name)
    g.tabs.forEach((t) => {
      const tabId = openTab(t.toolId, t.title)
      moveTabToGroup(tabId, gid)
    })
  }

  return (
    <div className="flex-1 overflow-y-auto p-1.5">
      {/* 分组收藏 */}
      {grouped.map(({ folder, items: fItems }) =>
        fItems.length === 0 ? null : (
          <div key={folder.id} className="mb-2">
            <div className="px-1.5 py-1 text-label text-ink-tertiary">{folder.name}</div>
            {fItems.map((i) => (
              <FavRow
                key={i.id}
                item={i}
                onRestore={() => (i.kind === 'tab' ? handleRestoreTab(i.id) : handleRestoreGroup(i.id))}
                onRemove={() => remove(i.id)}
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
    </div>
  )
}

function FavRow({
  item,
  onRestore,
  onRemove,
}: {
  item: { id: string; kind: 'tab' | 'group'; name: string; group?: { tabs: unknown[] }; tab?: unknown }
  onRestore: () => void
  onRemove: () => void
}) {
  return (
    <div className="group flex items-center gap-2 rounded-btn px-2 py-1.5 hover:bg-bg-hover">
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
