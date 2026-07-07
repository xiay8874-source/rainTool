import { useEffect, useState, useRef } from 'react'

interface DisplayInfo {
  display: { x: number; y: number; width: number; height: number; id: number }
  imageData: string | null
}

interface Selection {
  x: number
  y: number
  width: number
  height: number
}

export function OverlayApp() {
  const [displayInfo, setDisplayInfo] = useState<DisplayInfo | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const dragRef = useRef<{ startX: number; startY: number } | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    const unsub = window.raintool.onOverlayInit((data) => {
      setDisplayInfo(data)
    })
    return () => unsub()
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY }
    setSelection({ x: e.clientX, y: e.clientY, width: 0, height: 0 })
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return
    const startX = dragRef.current.startX
    const startY = dragRef.current.startY
    const x = Math.min(startX, e.clientX)
    const y = Math.min(startY, e.clientY)
    const width = Math.abs(e.clientX - startX)
    const height = Math.abs(e.clientY - startY)
    setSelection({ x, y, width, height })
  }

  const onMouseUp = () => {
    dragRef.current = null
  }

  const confirmSelection = async () => {
    if (!selection || selection.width < 5 || selection.height < 5) return
    if (!displayInfo) return
    if (confirming) return // 防止重复触发
    setConfirming(true)
    try {
      await window.raintool.confirmRegionCapture({
        x: selection.x,
        y: selection.y,
        width: selection.width,
        height: selection.height,
        displayId: displayInfo.display.id,
      })
    } catch {
      setConfirming(false)
    }
  }

  const cancel = () => {
    window.raintool.cancelCapture()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
      if (e.key === 'Enter') confirmSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, displayInfo, confirming])

  const maskColor = 'rgba(0,0,0,0.4)'

  return (
    <div
      style={{
        width: '100vw', height: '100vh', position: 'relative',
        cursor: 'crosshair', overflow: 'hidden',
        userSelect: 'none', background: 'transparent',
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {selection && selection.width > 0 && selection.height > 0 ? (
        <>
          {/* 选区边框 + box-shadow 实现遮罩透空 */}
          <div style={{
            position: 'absolute',
            left: selection.x, top: selection.y,
            width: selection.width, height: selection.height,
            border: '2px solid #3b82f6',
            boxShadow: '0 0 0 9999px ' + maskColor,
            boxSizing: 'border-box',
          }} />
          {/* 尺寸提示 */}
          <div style={{
            position: 'absolute',
            left: selection.x, top: selection.y + selection.height + 4,
            color: '#fff', fontSize: 12, background: 'rgba(0,0,0,0.7)',
            padding: '2px 6px', borderRadius: 3,
            whiteSpace: 'nowrap',
          }}>
            {Math.round(selection.width)} × {Math.round(selection.height)} · Enter 确认
          </div>
        </>
      ) : (
        <>
          <div style={{ position: 'absolute', inset: 0, background: maskColor, pointerEvents: 'none' }} />
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            color: '#fff', fontSize: 14, background: 'rgba(0,0,0,0.6)',
            padding: '6px 12px', borderRadius: 6,
          }}>
            拖拽选择截图区域 · Enter 确认 · Esc 取消
          </div>
        </>
      )}
    </div>
  )
}
