import { useEffect, useState } from 'react'
import { useScreenshotStore } from '@/store/screenshots'
import { useFabric, PALETTE, type DrawTool, type LineWidth } from './useFabric'

export function Editor({ tabId, onBack }: { tabId: string; onBack: () => void }) {
  const record = useScreenshotStore((s) => s.records.find((r) => r.id === tabId))
  const updateRecord = useScreenshotStore((s) => s.updateRecord)

  const [imageData, setImageData] = useState<string | null>(null)
  const [layersData, setLayersData] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showLayers, setShowLayers] = useState(true)

  const fabric = useFabric({
    backgroundImage: imageData ?? undefined,
    initialLayers: layersData,
  })

  // 加载图片和图层
  useEffect(() => {
    if (!record || loaded) return
    setLoaded(true)

    window.raintool?.readScreenshotFile(record.primary).then((url) => {
      if (url) setImageData(url)
    })

    // 加载图层数据(如果有)
    // 图层 JSON 存在 <id>.json,通过 readFile 读取
    // 但 readFile 只读 png — 需要一个读 JSON 的 IPC
    // 简化:用 storeGet 读?不行,JSON 是独立文件
    // 用 screenshot:readFile 读 .json 文件(它返回 base64 dataURL)
    // 但 .json 不是图片 — 需要另一个 IPC
    // 最简:主进程加一个 screenshot:readJson IPC
    // 暂时通过 readScreenshotFile 读 .json(它返回 base64 dataURL,解析出 JSON)
    if (record.layers) {
      const layersPath = record.layers
      window.raintool?.readScreenshotFile(layersPath).then((url) => {
        if (url) {
          // url 是 data:...;base64,xxx 格式,解析出 JSON 字符串
          try {
            const base64 = url.split(',')[1]
            const json = atob(base64)
            setLayersData(json)
          } catch { /* ignore */ }
        }
      })
    }
  }, [record, loaded])

  // 保存
  const handleSave = async () => {
    if (!record) return
    const layersJson = fabric.toJSON()
    const dataUrl = fabric.toDataURL()
    if (!dataUrl || !layersJson) return

    // 写图层 JSON 和合并 PNG 到磁盘
    await window.raintool.saveScreenshot(tabId, layersJson, dataUrl)

    // 更新 store 记录
    updateRecord(tabId, { layers: `${tabId}.json` })

    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const handleSaveAs = async () => {
    if (!record) return
    await window.raintool?.saveScreenshotAs(record.primary, record.name)
  }

  const handleCopy = async () => {
    if (!record) return
    await window.raintool?.copyScreenshotToClipboard(record.primary)
  }

  if (!record) {
    return (
      <div className="flex h-full items-center justify-center text-caption text-ink-tertiary">
        截图记录不存在
      </div>
    )
  }

  if (!imageData) {
    return (
      <div className="flex h-full items-center justify-center text-caption text-ink-tertiary">
        加载中…
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶部操作栏 */}
      <div className="flex items-center gap-2 border-b border-line bg-bg-surface px-4 py-1.5">
        <button onClick={onBack} className="rounded-btn border border-line px-2 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover">← 返回</button>

        {/* 撤销/重做 */}
        <div className="flex gap-1">
          <ToolIconButton onClick={fabric.undo} title="撤销">↶</ToolIconButton>
          <ToolIconButton onClick={fabric.redo} title="重做">↷</ToolIconButton>
        </div>

        <div className="h-4 w-px bg-line" />

        {/* 颜色 */}
        <div className="flex items-center gap-1">
          {PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => fabric.setColor(c)}
              className="rounded-full"
              style={{
                width: 16, height: 16, background: c, padding: 0, border: 'none', cursor: 'pointer',
                outline: fabric.color === c ? '2px solid #6366f1' : c === '#ffffff' ? '1px solid #555' : 'none',
              }}
            />
          ))}
        </div>

        <div className="h-4 w-px bg-line" />

        {/* 线宽 */}
        <div className="flex items-center gap-1">
          {(['thin', 'medium', 'thick'] as LineWidth[]).map((lw) => (
            <button
              key={lw}
              onClick={() => fabric.setLineWidth(lw)}
              title={lw}
              className="flex items-center justify-center rounded-btn"
              style={{
                padding: '2px 4px', border: 'none', cursor: 'pointer',
                background: fabric.lineWidth === lw ? '#e0e0e0' : 'transparent',
              }}
            >
              <div style={{
                width: 14,
                height: lw === 'thin' ? 2 : lw === 'medium' ? 4 : 7,
                background: '#6b7280', borderRadius: 2,
              }} />
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => setShowLayers(!showLayers)} className="rounded-btn border border-line px-2 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover">
            {showLayers ? '隐藏' : '显示'}面板
          </button>
          <button onClick={handleCopy} className="rounded-btn border border-line px-2 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover">复制</button>
          <button onClick={handleSaveAs} className="rounded-btn border border-line px-2 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover">另存为</button>
          <button onClick={handleSave} className="rounded-btn bg-accent px-2 py-0.5 text-caption text-white hover:opacity-90">💾 保存</button>
        </div>
      </div>

      {/* 主区:左工具栏 + 画布 + 右面板 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧工具栏 */}
        <div className="flex w-12 flex-col items-center gap-1 border-r border-line bg-bg-surface py-2">
          {EDITOR_TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => fabric.setTool(t.id)}
              title={t.label}
              className={`flex h-8 w-8 items-center justify-center rounded-btn text-base ${
                fabric.tool === t.id
                  ? 'bg-accent-bg text-accent'
                  : 'text-ink-secondary hover:bg-bg-hover hover:text-ink-primary'
              }`}
            >
              {t.icon}
            </button>
          ))}
        </div>

        {/* 画布区 */}
        <div className="flex flex-1 items-center justify-center overflow-auto bg-bg-app p-4">
          <div style={{ position: 'relative' }}>
            <canvas ref={fabric.canvasRef} />
          </div>
        </div>

        {/* 右侧面板 */}
        {showLayers && (
          <div className="w-48 border-l border-line bg-bg-surface p-2">
            <div className="mb-2 text-label font-bold text-ink-tertiary">图层</div>
            <LayerPanel fabricRef={fabric.fabricRef} />
            <div className="mt-3 mb-2 text-label font-bold text-ink-tertiary">滤镜</div>
            <FilterPanel fabricRef={fabric.fabricRef} />
          </div>
        )}
      </div>

      {/* 保存提示 */}
      {saved && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-btn bg-accent px-3 py-1 text-caption text-white shadow-float">
          ✓ 已保存
        </div>
      )}
    </div>
  )
}

const EDITOR_TOOLS: { id: DrawTool; label: string; icon: string }[] = [
  { id: 'select', label: '选择', icon: '↖' },
  { id: 'rect', label: '矩形', icon: '▭' },
  { id: 'ellipse', label: '椭圆', icon: '◯' },
  { id: 'arrow', label: '箭头', icon: '→' },
  { id: 'line', label: '直线', icon: '∕' },
  { id: 'pen', label: '画笔', icon: '✎' },
  { id: 'text', label: '文字', icon: 'T' },
  { id: 'mosaic', label: '马赛克', icon: '▦' },
  { id: 'highlight', label: '高亮', icon: '▮' },
  { id: 'number', label: '序号', icon: '①' },
  { id: 'eraser', label: '橡皮', icon: '⌫' },
]

function ToolIconButton({ children, onClick, title }: {
  children: React.ReactNode
  onClick: () => void
  title: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-6 w-6 items-center justify-center rounded-btn text-caption text-ink-secondary hover:bg-bg-hover hover:text-ink-primary"
    >
      {children}
    </button>
  )
}

function LayerPanel({ fabricRef }: { fabricRef: React.RefObject<{ current: unknown } | unknown> }) {
  const [, forceUpdate] = useState(0)
  const [selected] = useState<number | null>(null)

  const refresh = () => forceUpdate((n) => n + 1)

  const canvas = (fabricRef as React.MutableRefObject<unknown>).current as {
    getObjects: () => { type: string; visible: boolean }[]
    getActiveObject: () => { type: string; visible: boolean } | null
    setActiveObject: (obj: unknown) => void
    remove: (obj: unknown) => void
    discardActiveObject: () => void
    renderAll: () => void
  } | null

  if (!canvas) return <div className="text-label text-ink-tertiary">画布未就绪</div>

  const objects = canvas.getObjects()

  return (
    <div className="flex flex-col gap-1">
      {objects.length === 0 && (
        <div className="text-label text-ink-tertiary">无图层</div>
      )}
      {objects.map((obj, idx) => (
        <div
          key={idx}
          className={`flex items-center gap-1 rounded-btn px-1.5 py-1 text-label ${
            selected === idx ? 'border border-accent bg-accent-bg' : 'bg-bg-subtle'
          }`}
        >
          <button
            onClick={() => {
              obj.visible = !obj.visible
              canvas.renderAll()
              refresh()
            }}
            className="text-ink-secondary"
          >
            {obj.visible ? '👁' : '🚫'}
          </button>
          <span className="flex-1 truncate text-ink-secondary">{obj.type}</span>
          <button
            onClick={() => {
              canvas.remove(obj)
              canvas.discardActiveObject()
              canvas.renderAll()
              refresh()
            }}
            className="text-danger"
          >✕</button>
        </div>
      ))}
    </div>
  )
}

function FilterPanel({ fabricRef }: { fabricRef: React.RefObject<{ current: unknown } | unknown> }) {
  const applyFilter = (filter: 'none' | 'grayscale' | 'blur' | 'invert') => {
    const canvas = (fabricRef as React.MutableRefObject<unknown>).current as {
      backgroundImage?: { filters: unknown[] }
      renderAll: () => void
    } | null
    if (!canvas?.backgroundImage) return

    const bgImage = canvas.backgroundImage as { filters: unknown[] }
    bgImage.filters = []

    if (filter === 'grayscale') {
      // fabric 6 的滤镜 API
      bgImage.filters.push(new (window as unknown as { fabric: { filters: { Grayscale: new () => unknown } } }).fabric.filters.Grayscale())
    } else if (filter === 'invert') {
      bgImage.filters.push(new (window as unknown as { fabric: { filters: { Invert: new () => unknown } } }).fabric.filters.Invert())
    }
    // blur 需要特殊处理,fabric 6 的 Blur 滤镜
    // 简化:仅支持灰度和反色

    // @ts-expect-error applyFilters 在 fabric.Image 上
    canvas.backgroundImage.applyFilters?.()
    canvas.renderAll()
  }

  return (
    <div className="flex flex-col gap-1">
      {(['none', 'grayscale', 'invert'] as const).map((f) => (
        <button
          key={f}
          onClick={() => applyFilter(f)}
          className="rounded-btn bg-bg-subtle px-2 py-1 text-left text-label text-ink-secondary hover:bg-bg-hover"
        >
          {f === 'none' ? '无' : f === 'grayscale' ? '灰度' : '反色'}
        </button>
      ))}
    </div>
  )
}
