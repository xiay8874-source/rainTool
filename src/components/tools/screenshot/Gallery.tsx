import { useEffect, useState } from 'react'
import { useScreenshotStore, type ScreenshotRecord } from '@/store/screenshots'

export function Gallery({ onEdit }: { onEdit: (id: string) => void }) {
  const records = useScreenshotStore((s) => s.records)
  const hydrate = useScreenshotStore((s) => s.hydrate)
  const removeRecord = useScreenshotStore((s) => s.removeRecord)
  const renameRecord = useScreenshotStore((s) => s.renameRecord)
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<ScreenshotRecord | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    hydrate()
  }, [hydrate])

  const filtered = records.filter((r) =>
    r.name.toLowerCase().includes(search.toLowerCase()),
  )

  const handleDelete = async (rec: ScreenshotRecord) => {
    if (!confirm(`删除「${rec.name}」?`)) return
    await window.raintool?.deleteScreenshotFiles(rec.id)
    removeRecord(rec.id)
  }

  const handleRename = (rec: ScreenshotRecord) => {
    setRenaming(rec.id)
    setRenameValue(rec.name)
  }

  const confirmRename = (id: string) => {
    renameRecord(id, renameValue || '未命名')
    setRenaming(null)
  }

  const handleSaveAs = async (rec: ScreenshotRecord) => {
    await window.raintool?.saveScreenshotAs(rec.primary, rec.name)
  }

  const handleCopy = async (rec: ScreenshotRecord) => {
    await window.raintool?.copyScreenshotToClipboard(rec.primary)
  }

  const sourceLabel = (s: ScreenshotRecord['source']) =>
    s === 'fullscreen' ? '全屏' : s === 'region' ? '区域' : '窗口'

  return (
    <div className="flex h-full flex-col">
      {/* 顶部操作栏 */}
      <div className="flex items-center gap-2 border-b border-line bg-bg-surface px-4 py-2">
        <span className="text-page text-ink-primary">截图历史</span>
        <span className="text-label text-ink-tertiary">共 {records.length} 张</span>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称…"
            className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-primary outline-none focus:border-accent"
          />
        </div>
      </div>

      {/* 缩略图墙 */}
      <div className="flex-1 overflow-auto p-4">
        {filtered.length === 0 ? (
          <div className="mt-20 text-center text-caption text-ink-tertiary">
            {records.length === 0
              ? '暂无截图。使用快捷键截图(默认 ⌘⇧A 区域 / ⌘⇧S 全屏 / ⌘⇧W 窗口)'
              : '无匹配结果'}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {filtered.map((rec) => (
              <ThumbCard
                key={rec.id}
                rec={rec}
                sourceLabel={sourceLabel(rec.source)}
                renaming={renaming === rec.id}
                renameValue={renameValue}
                onRenameValueChange={setRenameValue}
                onConfirmRename={() => confirmRename(rec.id)}
                onCancelRename={() => setRenaming(null)}
                onClick={() => setPreview(rec)}
                onDoubleClick={() => onEdit(rec.id)}
                onEdit={() => onEdit(rec.id)}
                onDelete={() => handleDelete(rec)}
                onRename={() => handleRename(rec)}
                onSaveAs={() => handleSaveAs(rec)}
                onCopy={() => handleCopy(rec)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 放大预览 */}
      {preview && (
        <PreviewModal
          rec={preview}
          sourceLabel={sourceLabel(preview.source)}
          onClose={() => setPreview(null)}
          onEdit={() => { onEdit(preview.id); setPreview(null) }}
          onSaveAs={() => handleSaveAs(preview)}
          onCopy={() => handleCopy(preview)}
        />
      )}
    </div>
  )
}

function ThumbCard({
  rec, sourceLabel, renaming, renameValue, onRenameValueChange,
  onConfirmRename, onCancelRename, onClick, onDoubleClick,
  onEdit, onDelete, onRename, onSaveAs, onCopy,
}: {
  rec: ScreenshotRecord
  sourceLabel: string
  renaming: boolean
  renameValue: string
  onRenameValueChange: (v: string) => void
  onConfirmRename: () => void
  onCancelRename: () => void
  onClick: () => void
  onDoubleClick: () => void
  onEdit: () => void
  onDelete: () => void
  onRename: () => void
  onSaveAs: () => void
  onCopy: () => void
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.raintool?.readScreenshotFile(rec.thumb).then((url) => {
      if (!cancelled && url) setThumbUrl(url)
    })
    return () => { cancelled = true }
  }, [rec.thumb])

  return (
    <div className="group relative overflow-hidden rounded-card border border-line bg-bg-surface hover:border-line-strong">
      {/* 缩略图 */}
      <div
        className="aspect-video cursor-pointer overflow-hidden bg-bg-subtle"
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        {thumbUrl ? (
          <img src={thumbUrl} alt={rec.name} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center text-label text-ink-tertiary">加载中…</div>
        )}
      </div>

      {/* 信息栏 */}
      <div className="border-t border-line p-2">
        {renaming ? (
          <input
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onBlur={onConfirmRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfirmRename()
              if (e.key === 'Escape') onCancelRename()
            }}
            className="w-full rounded-btn border border-accent bg-bg-surface px-1 py-0.5 text-label text-ink-primary outline-none"
            autoFocus
          />
        ) : (
          <div className="truncate text-label text-ink-primary" title={rec.name}>{rec.name}</div>
        )}
        <div className="text-label text-ink-tertiary">
          {sourceLabel} · {rec.width}×{rec.height}
        </div>
      </div>

      {/* 悬浮操作 */}
      <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <CardBtn onClick={onEdit} title="编辑">✏</CardBtn>
        <CardBtn onClick={onCopy} title="复制">📋</CardBtn>
        <CardBtn onClick={onSaveAs} title="另存为">📁</CardBtn>
        <CardBtn onClick={onRename} title="重命名">✎</CardBtn>
        <CardBtn onClick={onDelete} title="删除" danger>✕</CardBtn>
      </div>
    </div>
  )
}

function CardBtn({ children, onClick, title, danger }: {
  children: React.ReactNode
  onClick: () => void
  title: string
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-5 w-5 items-center justify-center rounded-btn text-label ${
        danger
          ? 'bg-danger/80 text-white hover:bg-danger'
          : 'bg-bg-surface/90 text-ink-secondary hover:bg-bg-hover hover:text-ink-primary'
      }`}
    >
      {children}
    </button>
  )
}

function PreviewModal({
  rec, sourceLabel, onClose, onEdit, onSaveAs, onCopy,
}: {
  rec: ScreenshotRecord
  sourceLabel: string
  onClose: () => void
  onEdit: () => void
  onSaveAs: () => void
  onCopy: () => void
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null)

  useEffect(() => {
    window.raintool?.readScreenshotFile(rec.primary).then((url) => {
      if (url) setImgUrl(url)
    })
  }, [rec.primary])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-8"
      onClick={onClose}
    >
      {/* 操作栏 */}
      <div className="mb-3 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <span className="text-caption text-ink-tertiary">{rec.name}</span>
        <span className="text-label text-ink-tertiary">{sourceLabel} · {rec.width}×{rec.height}</span>
        <button onClick={onCopy} className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover">复制</button>
        <button onClick={onSaveAs} className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover">另存为</button>
        <button onClick={onEdit} className="rounded-btn bg-accent px-2 py-1 text-caption text-white hover:opacity-90">编辑</button>
        <button onClick={onClose} className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover">关闭</button>
      </div>
      {/* 图片 */}
      <div className="max-h-full max-w-full overflow-auto" onClick={(e) => e.stopPropagation()}>
        {imgUrl ? (
          <img src={imgUrl} alt={rec.name} className="max-h-[80vh] max-w-full object-contain" />
        ) : (
          <div className="text-caption text-ink-tertiary">加载中…</div>
        )}
      </div>
    </div>
  )
}
