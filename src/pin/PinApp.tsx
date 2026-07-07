import { useEffect, useState } from 'react'
import { useFabric, PALETTE, type DrawTool, type LineWidth } from '../components/tools/screenshot/useFabric'

// CSS 属性 -webkit-app-region 的类型补丁(React CSSProperties 不含此属性)
const dragRegion = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDragRegion = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

interface PinData {
  id: string
  name: string
  filePath: string
}

export function PinApp() {
  const [pinData, setPinData] = useState<PinData | null>(null)
  const [imageData, setImageData] = useState<string | null>(null)
  const [annotating, setAnnotating] = useState(false)
  const [showToolbar, setShowToolbar] = useState(false)
  const [saved, setSaved] = useState(false)

  const fabric = useFabric({
    backgroundImage: imageData ?? undefined,
    width: pinData ? undefined : 400,
    height: pinData ? undefined : 300,
  })

  // 接收主进程传来的截图信息
  useEffect(() => {
    const unsub = window.pin.onPinLoad((data) => {
      setPinData(data)
      window.pin.readFile(data.filePath).then((url) => {
        if (url) setImageData(url)
      })
    })
    return () => unsub()
  }, [])

  // 鼠标拖拽移动窗口 — 通过 CSS -webkit-app-region: drag 实现(见下方 style)
  // 不需要 JS 处理

  // 双击进入标注态
  const onDoubleClick = () => {
    setAnnotating(true)
    setShowToolbar(true)
  }

  // Esc / 点外部退出标注
  useEffect(() => {
    if (!annotating) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAnnotating(false)
        setShowToolbar(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [annotating])

  // 保存到历史
  const handleSave = async () => {
    if (!pinData) return
    const layersJson = fabric.toJSON()
    const dataUrl = fabric.toDataURL()
    if (!dataUrl) return

    // 将合并图写到临时文件(主进程会拷贝到 primary)
    // 用 dataURL 传给主进程太长,这里通过 layersJson + dataUrl 组合
    // 主进程 pin:save-to-history 接收 layersJson 和临时路径
    // 简化:直接传 dataUrl,主进程转存 — 但主进程没这个接口
    // 改为:写一个临时文件路径传过去
    // 实际上主进程 saveToHistory 需要文件路径,我们用 dataURL 写一个 Blob URL 不行
    // 最简方案:用 layersJson 通过 IPC,合并图用 base64 传

    // 重新设计:主进程 pin:save-to-history 已改为接受 layersJson + mergedPngPath
    // mergedPngPath 需要是一个磁盘文件。我们在 pin 窗口写不了文件(nodeIntegration=false)
    // 解决:新增一个 IPC 接受 base64 合并图
    // 但为了简化,这里只传 layersJson,合并图由主进程从 fabric canvas 重新渲染
    // 实际上 fabric 渲染在渲染进程,主进程无法重做
    // 最简:传 dataURL,主进程用 nativeImage.createFromDataURL 转存

    await window.pin.saveToHistory(pinData.id, layersJson, dataUrl)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  // 复制到剪贴板
  const handleCopy = async () => {
    if (!pinData) return
    await window.pin.copyToClipboard(pinData.filePath)
  }

  // 另存为
  const handleSaveAs = async () => {
    if (!pinData) return
    await window.pin.saveAs(pinData.filePath, pinData.name)
  }

  // 关闭
  const handleClose = async () => {
    if (!pinData) return
    await window.pin.close(pinData.id)
  }

  if (!imageData) {
    return (
      <div style={{ width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: '#999', fontSize: 12 }}>加载中…</span>
      </div>
    )
  }

  return (
    <div
      style={{
        width: '100vw', height: '100vh', position: 'relative',
        overflow: 'hidden', borderRadius: 4,
        ...(annotating ? noDragRegion : dragRegion),
      }}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => !annotating && setShowToolbar(true)}
      onMouseLeave={() => !annotating && setShowToolbar(false)}
    >
      {/* fabric 画布 */}
      <canvas
        ref={fabric.canvasRef}
        style={{ position: 'absolute', top: 0, left: 0 }}
      />

      {/* 悬浮态:右上角角标 */}
      {!annotating && showToolbar && (
        <div style={{
          position: 'absolute', top: 4, right: 4,
          display: 'flex', gap: 2, zIndex: 100,
          ...noDragRegion,
        }}>
          <PinBtn onClick={handleCopy} title="复制">📋</PinBtn>
          <PinBtn onClick={handleSave} title="保存到历史" green>💾</PinBtn>
          <PinBtn onClick={handleSaveAs} title="另存为">📁</PinBtn>
          <PinBtn onClick={handleClose} title="关闭" red>✕</PinBtn>
        </div>
      )}

      {/* 标注态:顶部工具栏 */}
      {annotating && (
        <PinToolbar fabric={fabric} onSave={handleSave} onClose={() => { setAnnotating(false); setShowToolbar(false) }} />
      )}

      {/* 保存成功提示 */}
      {saved && (
        <div style={{
          position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
          background: '#10b981', color: '#fff', padding: '4px 12px',
          borderRadius: 4, fontSize: 12, zIndex: 200,
        }}>
          ✓ 已保存到历史
        </div>
      )}
    </div>
  )
}

function PinBtn({ children, onClick, title, green, red }: {
  children: React.ReactNode
  onClick: () => void
  title: string
  green?: boolean
  red?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: green ? '#10b981' : red ? '#ef4444' : '#1f2937',
        color: '#fff', border: 'none', borderRadius: 3,
        padding: '3px 7px', fontSize: 12, cursor: 'pointer',
        opacity: 0.9,
      }}
    >
      {children}
    </button>
  )
}

// ============ 贴图轻量工具栏 ============

const TOOLS: { id: DrawTool; label: string; icon: string }[] = [
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

function PinToolbar({ fabric, onSave, onClose }: {
  fabric: ReturnType<typeof useFabric>
  onSave: () => void
  onClose: () => void
}) {
  return (
    <div style={{
      position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', gap: 0, padding: 3, zIndex: 100,
      background: '#1f2937', border: '1px solid #f59e0b', borderRadius: 8,
      ...noDragRegion,
    }}>
      {TOOLS.map((t) => (
        <button
          key={t.id}
          onClick={() => fabric.setTool(t.id)}
          title={t.label}
          style={{
            padding: '5px 8px', border: 'none', borderRadius: 5,
            fontSize: 13, cursor: 'pointer',
            background: fabric.tool === t.id ? '#f59e0b' : 'transparent',
            color: fabric.tool === t.id ? '#000' : '#9ca3af',
          }}
        >
          {t.icon}
        </button>
      ))}

      {/* 分隔线 */}
      <div style={{ width: 1, background: '#374151', margin: '0 4px' }} />

      {/* 颜色 */}
      {PALETTE.map((c) => (
        <button
          key={c}
          onClick={() => fabric.setColor(c)}
          style={{
            width: 18, height: 18, borderRadius: '50%', border: 'none',
            cursor: 'pointer', padding: 0,
            background: c,
            outline: fabric.color === c ? '2px solid #6366f1' : c === '#ffffff' ? '1px solid #555' : 'none',
            margin: '0 1px',
          }}
        />
      ))}

      {/* 分隔线 */}
      <div style={{ width: 1, background: '#374151', margin: '0 4px' }} />

      {/* 线宽 */}
      {(['thin', 'medium', 'thick'] as LineWidth[]).map((lw) => (
        <button
          key={lw}
          onClick={() => fabric.setLineWidth(lw)}
          title={lw}
          style={{
            padding: '5px 6px', border: 'none', borderRadius: 5,
            cursor: 'pointer',
            background: fabric.lineWidth === lw ? '#374151' : 'transparent',
          }}
        >
          <div style={{
            width: 16, height: lw === 'thin' ? 2 : lw === 'medium' ? 4 : 7,
            background: '#d1d5db', borderRadius: 2,
          }} />
        </button>
      ))}

      {/* 分隔线 */}
      <div style={{ width: 1, background: '#374151', margin: '0 4px' }} />

      {/* 撤销 */}
      <button
        onClick={fabric.undo}
        title="撤销"
        style={{
          padding: '5px 8px', border: 'none', borderRadius: 5,
          fontSize: 13, cursor: 'pointer',
          background: 'transparent', color: '#9ca3af',
        }}
      >↶</button>

      {/* 保存 */}
      <button
        onClick={onSave}
        title="保存到历史"
        style={{
          padding: '5px 10px', border: 'none', borderRadius: 5,
          fontSize: 12, cursor: 'pointer', fontWeight: 'bold',
          background: '#10b981', color: '#000',
        }}
      >💾</button>

      {/* 关闭标注 */}
      <button
        onClick={onClose}
        title="退出标注"
        style={{
          padding: '5px 8px', border: 'none', borderRadius: 5,
          fontSize: 13, cursor: 'pointer',
          background: 'transparent', color: '#ef4444',
        }}
      >✕</button>
    </div>
  )
}
