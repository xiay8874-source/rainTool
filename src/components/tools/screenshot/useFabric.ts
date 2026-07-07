import { useRef, useEffect, useState, useCallback } from 'react'
import * as fabric from 'fabric'

// ============ 绘图工具类型 ============

export type DrawTool =
  | 'select'    // 选择/移动
  | 'rect'      // 矩形(默认)
  | 'ellipse'   // 椭圆
  | 'arrow'     // 箭头
  | 'line'      // 直线
  | 'pen'       // 画笔
  | 'text'      // 文字
  | 'mosaic'    // 马赛克
  | 'highlight' // 高亮笔
  | 'number'    // 序号标注
  | 'eraser'    // 橡皮擦

// ============ 颜色与线宽 ============

export const PALETTE = [
  '#ef4444', // 红
  '#f59e0b', // 橙
  '#10b981', // 绿
  '#3b82f6', // 蓝
  '#8b5cf6', // 紫
  '#ffffff', // 白
  '#000000', // 黑
  '#fbbf24', // 黄
] as const

export type LineWidth = 'thin' | 'medium' | 'thick'

export const LINE_WIDTH_MAP: Record<LineWidth, number> = {
  thin: 2,
  medium: 4,
  thick: 8,
}

// ============ fabric 画布管理 hook ============

export interface UseFabricOptions {
  /** 底图 dataURL */
  backgroundImage?: string
  /** 初始图层 JSON(从已保存的图层恢复) */
  initialLayers?: string | null
  /** 尺寸 */
  width?: number
  height?: number
}

export function useFabric(opts: UseFabricOptions = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fabricRef = useRef<fabric.Canvas | null>(null)
  const [ready, setReady] = useState(false)

  // 绘图状态
  const [tool, setTool] = useState<DrawTool>('rect')
  const [color, setColor] = useState<string>(PALETTE[0])
  const [lineWidth, setLineWidth] = useState<LineWidth>('medium')
  const numberCounter = useRef(1)

  // 临时绘制状态(鼠标拖拽中创建的对象)
  const drawingRef = useRef<{
    startX: number
    startY: number
    obj: fabric.Object | null
    isDrawing: boolean
  }>({ startX: 0, startY: 0, obj: null, isDrawing: false })

  // 初始化 fabric canvas
  useEffect(() => {
    if (!canvasRef.current) return
    const canvas = new fabric.Canvas(canvasRef.current, {
      selection: false,
      preserveObjectStacking: true,
    })
    fabricRef.current = canvas
    setReady(true)

    return () => {
      canvas.dispose()
      fabricRef.current = null
    }
  }, [])

  // 加载底图
  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas || !opts.backgroundImage) return

    fabric.Image.fromURL(opts.backgroundImage).then((img) => {
      canvas.backgroundImage = img
      canvas.renderAll()
    })
  }, [opts.backgroundImage])

  // 加载已保存的图层
  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas || !opts.initialLayers || !ready) return

    try {
      canvas.loadFromJSON(opts.initialLayers).then(() => {
        canvas.renderAll()
        // 恢复序号计数器:扫描已有 number 对象
        let maxNum = 0
        canvas.getObjects().forEach((obj) => {
          const n = (obj as unknown as { _numberLabel?: number })._numberLabel
          if (typeof n === 'number' && n > maxNum) maxNum = n
        })
        numberCounter.current = maxNum + 1
      })
    } catch {
      /* 加载失败忽略 */
    }
  }, [opts.initialLayers, ready])

  // ---- 创建各种图形对象的工厂 ----

  const createArrow = useCallback((x1: number, y1: number, x2: number, y2: number, stroke: string, width: number) => {
    const headLength = Math.max(12, width * 3)
    const angle = Math.atan2(y2 - y1, x2 - x1)
    const headX1 = x2 - headLength * Math.cos(angle - Math.PI / 6)
    const headY1 = y2 - headLength * Math.sin(angle - Math.PI / 6)
    const headX2 = x2 - headLength * Math.cos(angle + Math.PI / 6)
    const headY2 = y2 - headLength * Math.sin(angle + Math.PI / 6)

    return new fabric.Path(
      `M ${x1} ${y1} L ${x2} ${y2} M ${x2} ${y2} L ${headX1} ${headY1} M ${x2} ${y2} L ${headX2} ${headY2}`,
      { stroke, strokeWidth: width, fill: 'transparent' },
    )
  }, [])

  const createNumber = useCallback((x: number, y: number, stroke: string, num: number) => {
    const radius = 16
    const circle = new fabric.Circle({
      left: x - radius,
      top: y - radius,
      radius,
      fill: stroke,
      stroke: stroke,
      strokeWidth: 0,
      selectable: true,
    })
    const text = new fabric.Text(String(num), {
      left: x - 6,
      top: y - 10,
      fontSize: 18,
      fill: '#ffffff',
      fontFamily: 'Arial',
      selectable: true,
    })
    const group = new fabric.Group([circle, text], {
      left: x - radius,
      top: y - radius,
    })
    ;(group as unknown as { _numberLabel: number })._numberLabel = num
    return group
  }, [])

  // ---- 鼠标事件处理 ----

  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas || !ready) return

    const getPointer = (e: fabric.TPointerEventInfo) => {
      const point = canvas.getScenePoint(e.e)
      return { x: point.x, y: point.y }
    }

    const onMouseDown = (e: fabric.TPointerEventInfo) => {
      if (tool === 'select') return
      const pointer = getPointer(e)
      drawingRef.current = { startX: pointer.x, startY: pointer.y, obj: null, isDrawing: true }

      const lw = LINE_WIDTH_MAP[lineWidth]

      if (tool === 'text') {
        const text = new fabric.IText('文字', {
          left: pointer.x,
          top: pointer.y,
          fontSize: 20,
          fill: color,
          fontFamily: 'Arial',
        })
        canvas.add(text)
        canvas.setActiveObject(text)
        text.enterEditing()
        drawingRef.current.isDrawing = false
        return
      }

      if (tool === 'number') {
        const num = createNumber(pointer.x, pointer.y, color, numberCounter.current)
        canvas.add(num)
        numberCounter.current++
        drawingRef.current.isDrawing = false
        return
      }

      if (tool === 'pen') {
        const path = new fabric.PencilBrush(canvas)
        path.color = color
        path.width = lw
        canvas.freeDrawingBrush = path
        canvas.isDrawingMode = true
        return
      }

      if (tool === 'eraser') {
        // 点击删除对象
        const target = canvas.findTarget(e.e)
        if (target) {
          canvas.remove(target)
          canvas.discardActiveObject()
        }
        drawingRef.current.isDrawing = false
        return
      }

      // 以下工具需要拖拽创建
      let obj: fabric.Object | null = null
      if (tool === 'rect') {
        obj = new fabric.Rect({
          left: pointer.x, top: pointer.y, width: 0, height: 0,
          fill: 'transparent', stroke: color, strokeWidth: lw,
        })
      } else if (tool === 'ellipse') {
        obj = new fabric.Ellipse({
          left: pointer.x, top: pointer.y, rx: 0, ry: 0,
          fill: 'transparent', stroke: color, strokeWidth: lw,
        })
      } else if (tool === 'line') {
        obj = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
          stroke: color, strokeWidth: lw,
        })
      } else if (tool === 'arrow') {
        obj = new fabric.Path(`M ${pointer.x} ${pointer.y} L ${pointer.x} ${pointer.y}`, {
          stroke: color, strokeWidth: lw, fill: 'transparent',
        })
      } else if (tool === 'highlight') {
        obj = new fabric.Rect({
          left: pointer.x, top: pointer.y, width: 0, height: LINE_WIDTH_MAP['thick'] * 2,
          fill: color, stroke: 'transparent', strokeWidth: 0,
          opacity: 0.35,
        })
      } else if (tool === 'mosaic') {
        // 马赛克:用半透明矩形占位,松手时栅格化
        obj = new fabric.Rect({
          left: pointer.x, top: pointer.y, width: 0, height: 0,
          fill: 'rgba(128,128,128,0.6)', stroke: 'transparent', strokeWidth: 0,
        })
      }

      if (obj) {
        drawingRef.current.obj = obj
        canvas.add(obj)
      }
    }

    const onMouseMove = (e: fabric.TPointerEventInfo) => {
      if (!drawingRef.current.isDrawing || !drawingRef.current.obj) return
      const pointer = getPointer(e)
      const obj = drawingRef.current.obj
      const startX = drawingRef.current.startX
      const startY = drawingRef.current.startY

      if (tool === 'rect' || tool === 'mosaic' || tool === 'highlight') {
        const left = Math.min(startX, pointer.x)
        const top = Math.min(startY, pointer.y)
        const width = Math.abs(pointer.x - startX)
        const height = tool === 'highlight'
          ? LINE_WIDTH_MAP['thick'] * 2
          : Math.abs(pointer.y - startY)
        obj.set({ left, top, width, height })
        obj.setCoords()
      } else if (tool === 'ellipse') {
        const left = Math.min(startX, pointer.x)
        const top = Math.min(startY, pointer.y)
        const rx = Math.abs(pointer.x - startX) / 2
        const ry = Math.abs(pointer.y - startY) / 2
        obj.set({ left, top, rx, ry })
        obj.setCoords()
      } else if (tool === 'line') {
        const line = obj as fabric.Line
        line.set({ x2: pointer.x, y2: pointer.y })
        line.setCoords()
      } else if (tool === 'arrow') {
        // 重建箭头 path
        const stroke = color
        const lw = LINE_WIDTH_MAP[lineWidth]
        const newObj = createArrow(startX, startY, pointer.x, pointer.y, stroke, lw)
        canvas.remove(obj)
        canvas.add(newObj)
        drawingRef.current.obj = newObj
      }

      canvas.renderAll()
    }

    const onMouseUp = () => {
      if (tool === 'pen') {
        canvas.isDrawingMode = false
      }
      if (drawingRef.current.isDrawing && drawingRef.current.obj) {
        // 马赛克特殊处理:栅格化区域
        if (tool === 'mosaic' && drawingRef.current.obj) {
          const mosaicObj = drawingRef.current.obj as fabric.Rect
          const w = mosaicObj.width || 1
          const h = mosaicObj.height || 1
          if (w > 5 && h > 5) {
            // 将区域转为马赛克像素块
            const blockSize = 8
            const cols = Math.ceil(w / blockSize)
            const rows = Math.ceil(h / blockSize)
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                const block = new fabric.Rect({
                  left: (mosaicObj.left || 0) + c * blockSize,
                  top: (mosaicObj.top || 0) + r * blockSize,
                  width: blockSize,
                  height: blockSize,
                  fill: ['rgba(0,0,0,0.15)', 'rgba(255,255,255,0.1)', 'rgba(128,128,128,0.2)'][(r + c) % 3],
                  stroke: 'transparent',
                  strokeWidth: 0,
                  selectable: true,
                })
                canvas.add(block)
              }
            }
            canvas.remove(mosaicObj)
          }
        }
        drawingRef.current.obj.setCoords()
      }
      drawingRef.current.isDrawing = false
      drawingRef.current.obj = null
    }

    canvas.on('mouse:down', onMouseDown)
    canvas.on('mouse:move', onMouseMove)
    canvas.on('mouse:up', onMouseUp)

    return () => {
      canvas.off('mouse:down', onMouseDown)
      canvas.off('mouse:move', onMouseMove)
      canvas.off('mouse:up', onMouseUp)
    }
  }, [tool, color, lineWidth, ready, createArrow, createNumber])

  // ---- 撤销/重做 ----
  const undoStack = useRef<string[]>([])
  const redoStack = useRef<string[]>([])
  const isUndoRedoing = useRef(false)

  // 记录状态(在操作完成后调用)
  const saveState = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas || isUndoRedoing.current) return
    const json = JSON.stringify(canvas.toJSON())
    undoStack.current.push(json)
    if (undoStack.current.length > 50) undoStack.current.shift()
    redoStack.current = []
  }, [])

  const undo = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas || undoStack.current.length === 0) return
    isUndoRedoing.current = true
    const current = JSON.stringify(canvas.toJSON())
    redoStack.current.push(current)
    const prev = undoStack.current.pop()!
    canvas.loadFromJSON(prev).then(() => {
      canvas.renderAll()
      isUndoRedoing.current = false
    })
  }, [])

  const redo = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas || redoStack.current.length === 0) return
    isUndoRedoing.current = true
    const current = JSON.stringify(canvas.toJSON())
    undoStack.current.push(current)
    const next = redoStack.current.pop()!
    canvas.loadFromJSON(next).then(() => {
      canvas.renderAll()
      isUndoRedoing.current = false
    })
  }, [])

  // ---- 序列化/导出 ----

  const toJSON = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return null
    return JSON.stringify(canvas.toJSON())
  }, [])

  const toDataURL = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return null
    return canvas.toDataURL({ format: 'png', multiplier: 1 })
  }, [])

  return {
    canvasRef,
    fabricRef,
    ready,
    tool, setTool,
    color, setColor,
    lineWidth, setLineWidth,
    saveState,
    undo, redo,
    toJSON, toDataURL,
  }
}
