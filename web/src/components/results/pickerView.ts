import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { clamp } from './frameUtil'
import type { FrameShot, Rect } from './imageSearchState'

// 영역 고르기 창(직사각형 RectPicker · 꼭짓점 QuadPicker)의 보기 칸: 지금 프레임을 보이는 부분만 캔버스에 그리고
// 확대하면 픽셀이 또렷하게(부드럽게 하지 않음), 크게 확대하면 픽셀 경계선. 휠 = 커서 기준 확대·축소,
// Space 또는 가운데 버튼 + 끌기 = 이동, +/−/0 키

/** 보기: 배율(화면 px / 프레임 px)과 화면 왼쪽 위의 프레임 좌표 */
export interface PickerView { zoom: number; x: number; y: number }

const MAX_ZOOM = 40
// 이 배율부터 픽셀 경계선을 그린다
const GRID_ZOOM = 8

export function usePickerView(frame: FrameShot) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const panRef = useRef<{ x: number; y: number; view: PickerView } | null>(null)
  // 화면(보기 칸) 크기 · 보기(null이면 화면에 맞춤)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [view, setView] = useState<PickerView | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const [space, setSpace] = useState(false)
  const [panning, setPanning] = useState(false)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setSize({ w: Math.round(width), h: Math.round(height) })
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  const fit = size ? Math.min(size.w / frame.width, size.h / frame.height) : null
  const minZoom = fit ? Math.min(fit, 1) / 2 : 0.05
  const v = useMemo<PickerView | null>(
    () => view ?? (size && fit ? { zoom: fit, x: (frame.width - size.w / fit) / 2, y: (frame.height - size.h / fit) / 2 } : null),
    [view, size, fit, frame],
  )

  // 보이는 부분만 그린다
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size || !v) return
    const dpr = window.devicePixelRatio || 1
    const width = Math.round(size.w * dpr)
    const height = Math.round(size.h * dpr)
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, width, height)
    const s = v.zoom * dpr
    const x0 = Math.max(0, Math.floor(v.x))
    const y0 = Math.max(0, Math.floor(v.y))
    const x1 = Math.min(frame.width, Math.ceil(v.x + size.w / v.zoom))
    const y1 = Math.min(frame.height, Math.ceil(v.y + size.h / v.zoom))
    if (x1 <= x0 || y1 <= y0) return
    context.imageSmoothingEnabled = v.zoom < 1
    context.drawImage(frame.canvas, x0, y0, x1 - x0, y1 - y0, (x0 - v.x) * s, (y0 - v.y) * s, (x1 - x0) * s, (y1 - y0) * s)
    if (v.zoom < GRID_ZOOM) return
    context.strokeStyle = 'rgba(128, 128, 128, 0.45)'
    context.lineWidth = 1
    context.beginPath()
    for (let x = x0; x <= x1; x++) {
      const p = Math.round((x - v.x) * s) + 0.5
      context.moveTo(p, (y0 - v.y) * s)
      context.lineTo(p, (y1 - v.y) * s)
    }
    for (let y = y0; y <= y1; y++) {
      const p = Math.round((y - v.y) * s) + 0.5
      context.moveTo((x0 - v.x) * s, p)
      context.lineTo((x1 - v.x) * s, p)
    }
    context.stroke()
  }, [frame, v, size])

  /** 화면 점(cx, cy)은 그대로 두고 배율을 바꾼다 */
  const zoomAt = (zoom: number, cx: number, cy: number) => {
    if (!v) return
    const z = clamp(zoom, minZoom, MAX_ZOOM)
    setView({ zoom: z, x: v.x + cx / v.zoom - cx / z, y: v.y + cy / v.zoom - cy / z })
  }
  const zoomBy = (factor: number) => v && size && zoomAt(v.zoom * factor, size.w / 2, size.h / 2)
  /** 원래 크기 (프레임 1픽셀 = 화면 1픽셀), 화면 가운데 기준 */
  const actualSize = () => size && zoomAt(1, size.w / 2, size.h / 2)
  /** 이 부분을 크게 (둘레 1.5배) */
  const zoomTo = (r: Rect) => {
    if (!size) return
    const z = clamp(Math.min(size.w / (r.w * 1.5), size.h / (r.h * 1.5)), minZoom, MAX_ZOOM)
    setView({ zoom: z, x: r.x + r.w / 2 - size.w / 2 / z, y: r.y + r.h / 2 - size.h / 2 / z })
  }

  // 휠: 커서 위치 기준 확대·축소 (페이지가 스크롤·확대되지 않게 passive 아님)
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = box.getBoundingClientRect()
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1)
      zoomAt((v?.zoom ?? 1) * Math.exp(-delta * 0.002), e.clientX - r.left, e.clientY - r.top)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  })

  /** 화면 좌표 → 프레임 좌표 (소수) */
  const toFrame = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current?.getBoundingClientRect()
    if (!r || !v) return null
    return { x: v.x + (e.clientX - r.left) / v.zoom, y: v.y + (e.clientY - r.top) / v.zoom }
  }
  /** 가운데 버튼 또는 Space + 왼쪽 버튼이면 화면 이동을 시작하고 true */
  const startPan = (e: React.PointerEvent): boolean => {
    if (!v || !(e.button === 1 || (e.button === 0 && space))) return false
    panRef.current = { x: e.clientX, y: e.clientY, view: v }
    setPanning(true)
    return true
  }
  /** 커서 픽셀 좌표를 갱신하고, 이동 중이면 보기를 옮기고 true */
  const movePan = (e: React.PointerEvent): boolean => {
    const p = toFrame(e)
    setHover(p && p.x >= 0 && p.y >= 0 && p.x < frame.width && p.y < frame.height ? { x: Math.floor(p.x), y: Math.floor(p.y) } : null)
    const d = panRef.current
    if (!d) return false
    setView({ zoom: d.view.zoom, x: d.view.x - (e.clientX - d.x) / d.view.zoom, y: d.view.y - (e.clientY - d.y) / d.view.zoom })
    return true
  }
  const endPan = () => {
    panRef.current = null
    setPanning(false)
  }
  /** Space(누른 채 끌기 = 이동) · + − 0 (맞춤). 처리했으면 true */
  const viewKeyDown = (e: React.KeyboardEvent): boolean => {
    const typing = (e.target as HTMLElement).tagName === 'INPUT'
    if (e.code === 'Space') {
      if (typing) return false
      e.preventDefault()
      if (!e.repeat) setSpace(true)
      return true
    }
    if (typing) return false
    if (e.key === '+' || e.key === '=') zoomBy(2)
    else if (e.key === '-') zoomBy(0.5)
    else if (e.key === '0') setView(null)
    else return false
    return true
  }
  const viewKeyUp = (e: React.KeyboardEvent) => {
    if (e.code !== 'Space') return
    e.preventDefault()
    setSpace(false)
  }

  return {
    boxRef, canvasRef, size, v, hover, setHover, space, panning, setView, zoomBy, actualSize, zoomTo, toFrame, startPan, movePan, endPan,
    viewKeyDown, viewKeyUp,
  }
}

export type PickerViewState = ReturnType<typeof usePickerView>
