import { useMemo, useState } from 'react'
import type { DiagramMetadata, DiagramRevisionMetadata } from '../../../electron/diagram-types'
import { useDiagramStore } from '@/store/diagrams'
import { useAppStore } from '@/store/tabs'
import type { ToolProps } from './shared'

const SOURCE_LABEL: Record<DiagramMetadata['source'], string> = {
  raintool: 'RainTool',
  zcode: 'ZCode',
  codex: 'Codex',
  mcp: 'MCP',
  legacy: '历史会话',
}

export default function DiagramManager(_props: ToolProps) {
  const items = useDiagramStore((state) => state.items)
  const loaded = useDiagramStore((state) => state.loaded)
  const error = useDiagramStore((state) => state.error)
  const refresh = useDiagramStore((state) => state.refresh)
  const createDiagram = useDiagramStore((state) => state.createDiagram)
  const duplicateDiagram = useDiagramStore((state) => state.duplicateDiagram)
  const renameDiagram = useDiagramStore((state) => state.renameDiagram)
  const setFavorite = useDiagramStore((state) => state.setFavorite)
  const deleteDiagram = useDiagramStore((state) => state.deleteDiagram)
  const openDiagramTab = useAppStore((state) => state.openDiagramTab)
  const [query, setQuery] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [history, setHistory] = useState<{ item: DiagramMetadata; revisions: DiagramRevisionMetadata[] } | null>(null)

  void _props
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return items.filter((item) => {
      if (favoriteOnly && !item.favorite) return false
      if (!search) return true
      return (
        item.title.toLocaleLowerCase().includes(search) ||
        item.tags.some((tag) => tag.toLocaleLowerCase().includes(search)) ||
        item.sourceClient?.toLocaleLowerCase().includes(search)
      )
    })
  }, [favoriteOnly, items, query])

  const run = async (id: string, action: () => Promise<void>) => {
    setPendingId(id)
    try { await action() } finally { setPendingId(null) }
  }

  const createNew = async () => {
    const document = await createDiagram('未命名图纸')
    openDiagramTab(document.id, document.title)
  }

  const rename = async (item: DiagramMetadata) => {
    const title = window.prompt('图纸名称', item.title)?.trim()
    if (!title || title === item.title) return
    await run(item.id, async () => { await renameDiagram(item.id, title) })
  }

  const duplicate = async (item: DiagramMetadata) => {
    await run(item.id, async () => {
      const document = await duplicateDiagram(item.id)
      openDiagramTab(document.id, document.title)
    })
  }

  const remove = async (item: DiagramMetadata) => {
    if (!window.confirm(`确定删除图纸“${item.title}”吗？历史版本也会一并删除。`)) return
    await run(item.id, async () => { await deleteDiagram(item.id) })
  }

  const showHistory = async (item: DiagramMetadata) => {
    await run(item.id, async () => {
      const revisions = await window.raintool.listDiagramRevisions(item.id)
      setHistory({ item, revisions })
    })
  }

  const restoreRevision = async (revision: number) => {
    if (!history) return
    const document = await window.raintool.getDiagram(history.item.id)
    if (!document) return
    if (!window.confirm(`恢复“${history.item.title}”到版本 ${revision}？当前内容会自动进入历史。`)) return
    await run(history.item.id, async () => {
      await window.raintool.restoreDiagramRevision(history.item.id, revision, document.revision)
      await refresh()
      setHistory(null)
      openDiagramTab(history.item.id, history.item.title)
    })
  }

  return (
    <div className="h-full overflow-auto bg-bg-app p-5">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索图纸、标签或来源…"
            className="min-w-64 flex-1 rounded-btn border border-line bg-bg-surface px-3 py-2 text-body text-ink-primary outline-none focus:border-accent"
          />
          <button
            onClick={() => setFavoriteOnly((value) => !value)}
            className={`rounded-btn border px-3 py-2 text-caption ${favoriteOnly ? 'border-accent bg-accent-bg text-accent' : 'border-line text-ink-secondary hover:bg-bg-hover'}`}
          >
            ★ 仅收藏
          </button>
          <button onClick={() => void refresh()} className="rounded-btn border border-line px-3 py-2 text-caption text-ink-secondary hover:bg-bg-hover">
            刷新
          </button>
          <button onClick={() => void createNew()} className="rounded-btn bg-accent px-3 py-2 text-caption text-white hover:opacity-90">
            + 新建图纸
          </button>
        </div>

        {error && <div className="mb-4 rounded-card border border-danger/30 bg-danger/5 p-3 text-body text-danger">{error}</div>}
        {!loaded && <div className="py-12 text-center text-body text-ink-tertiary">正在读取图纸库…</div>}
        {loaded && filtered.length === 0 && (
          <div className="rounded-card border border-dashed border-line p-12 text-center text-body text-ink-tertiary">
            {query || favoriteOnly ? '没有匹配的图纸' : '暂无图纸，点击“新建图纸”开始'}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <div key={item.id} className="rounded-card border border-line bg-bg-surface p-4 shadow-sm hover:border-line-strong">
              <div className="mb-3 flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-accent-bg text-lg text-accent">◇</div>
                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => openDiagramTab(item.id, item.title)}
                    className="block w-full truncate text-left text-page text-ink-primary hover:text-accent"
                    title={item.title}
                  >
                    {item.title}
                  </button>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-label text-ink-tertiary">
                    <span>{SOURCE_LABEL[item.source]}</span>
                    {item.sourceClient && <span>· {item.sourceClient}</span>}
                    <span>· v{item.revision}</span>
                  </div>
                </div>
                <button
                  onClick={() => void run(item.id, async () => { await setFavorite(item.id, !item.favorite) })}
                  className={item.favorite ? 'text-accent' : 'text-ink-tertiary hover:text-accent'}
                  title={item.favorite ? '取消收藏' : '收藏'}
                >
                  ★
                </button>
              </div>
              <div className="mb-3 text-caption text-ink-tertiary">
                更新于 {new Date(item.updatedAt).toLocaleString()}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <SmallButton onClick={() => openDiagramTab(item.id, item.title)}>打开</SmallButton>
                <SmallButton onClick={() => void rename(item)}>重命名</SmallButton>
                <SmallButton onClick={() => void duplicate(item)}>复制</SmallButton>
                <SmallButton onClick={() => void showHistory(item)}>历史</SmallButton>
                <SmallButton danger onClick={() => void remove(item)}>删除</SmallButton>
              </div>
              {pendingId === item.id && <div className="mt-2 text-label text-ink-tertiary">处理中…</div>}
            </div>
          ))}
        </div>
      </div>

      {history && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-6" onClick={() => setHistory(null)}>
          <div className="w-full max-w-md rounded-card border border-line bg-bg-surface p-4 shadow-float" onClick={(event) => event.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-page text-ink-primary">{history.item.title} · 历史版本</div>
              <button onClick={() => setHistory(null)} className="text-ink-tertiary hover:text-ink-primary">×</button>
            </div>
            {history.revisions.length === 0 ? (
              <div className="py-6 text-center text-body text-ink-tertiary">尚无历史版本</div>
            ) : (
              <div className="max-h-80 space-y-1 overflow-auto">
                {history.revisions.map((revision) => (
                  <div key={revision.revision} className="flex items-center justify-between rounded-btn px-2 py-2 hover:bg-bg-hover">
                    <div>
                      <div className="text-body text-ink-primary">版本 {revision.revision}</div>
                      <div className="text-label text-ink-tertiary">{new Date(revision.savedAt).toLocaleString()}</div>
                    </div>
                    <SmallButton onClick={() => void restoreRevision(revision.revision)}>恢复</SmallButton>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SmallButton({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-btn border border-line px-2 py-1 text-label hover:bg-bg-hover ${danger ? 'text-danger' : 'text-ink-secondary hover:text-ink-primary'}`}
    >
      {children}
    </button>
  )
}
