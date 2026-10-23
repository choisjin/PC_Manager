import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatDuration } from '../../format'
import { tr } from '../../i18n/engine'
import { ColumnFilterMenu } from './ColumnFilter'
import { formatWall, type ResultRow } from './resultCsv'
import { toMessage } from './resultSessions'
import { rowAtTime } from './sync'
import { copyTable, downloadXlsx } from './tableExport'
import {
  type AreaMode, areaOf, type CropTarget, type FrameShot, type ImageSearchState, type Rect, RESULT_COLUMNS, type ResultColumn, type SearchScope,
  type SearchVideo, type Segment, type StepSource, stepWindows,
} from './imageSearchState'

// 결과 확인 이미지 찾기 화면: 영상 위 크롭·영역 표시(CropOverlay) · 크롭 창(CropDialog) · 설정·진행·찾은 구간(ImageSearchPanel).
// 상태·찾기 작업은 imageSearchState

/** 프레임의 rect 부분을 회색조로 (BT.601 밝기) */
function captureTemplate(source: CanvasImageSource, rect: Rect): { gray: Uint8Array; preview: string } {
  const canvas = document.createElement('canvas')
  canvas.width = rect.w
  canvas.height = rect.h
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('캔버스를 만들지 못했습니다')
  context.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  const data = context.getImageData(0, 0, rect.w, rect.h).data
  const gray = new Uint8Array(rect.w * rect.h)
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114)
  return { gray, preview: canvas.toDataURL('image/png') }
}

/** 초 → m:ss.mmm (프레임 단위로 보이게) */
function formatFrameTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${s.toFixed(3).padStart(6, '0')}`
}

// ─────────────────────────────── 영상 위 크롭·영역 표시 (VideoTransport의 영상 칸 안, 고르기는 크롭 창에서)

export function CropOverlay({ state, videoRef, currentPath }: {
  state: ImageSearchState
  videoRef: React.RefObject<HTMLVideoElement | null>
  currentPath: string | null
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  // 영상이 실제로 그려진 칸 (object-fit: contain의 여백 제외): 오버레이 기준 화면 좌표 + 배율 + 지금 영상의 원래 크기
  const [view, setView] = useState<{ left: number; top: number; scale: number; vw: number; vh: number } | null>(null)

  useLayoutEffect(() => {
    const video = videoRef.current
    const box = boxRef.current
    if (!video || !box) return
    const measure = () => {
      if (!video.videoWidth || !video.videoHeight) return setView(null)
      const v = video.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      const scale = Math.min(v.width / video.videoWidth, v.height / video.videoHeight)
      setView({
        left: v.left - b.left + (v.width - video.videoWidth * scale) / 2,
        top: v.top - b.top + (v.height - video.videoHeight * scale) / 2,
        scale,
        vw: video.videoWidth,
        vh: video.videoHeight,
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(video)
    observer.observe(box)
    video.addEventListener('loadedmetadata', measure)
    return () => {
      observer.disconnect()
      video.removeEventListener('loadedmetadata', measure)
    }
  }, [videoRef, currentPath, state.open])

  if (!state.open) return null
  const template = state.template
  // 크롭·영역은 크롭한 영상 크기 기준: 크기가 다른 영상에서는 늘려 그린다 (에이전트도 같은 크기로 맞춰 비교)
  /** 크롭한 영상 픽셀 사각형 → 오버레이 안 위치 */
  const place = (r: Rect) => view && template && ({
    left: view.left + (r.x * view.vw / template.frameWidth) * view.scale,
    top: view.top + (r.y * view.vh / template.frameHeight) * view.scale,
    width: (r.w * view.vw / template.frameWidth) * view.scale,
    height: (r.h * view.vh / template.frameHeight) * view.scale,
  })
  const area = areaOf(state)
  return (
    <div ref={boxRef} className="rv-crop">
      {template && area && area !== template.rect && <div className="rv-crop-area" style={place(area) ?? undefined} />}
      {template && <div className="rv-crop-rect" style={place(template.rect) ?? undefined} />}
    </div>
  )
}

// ─────────────────────────────── 크롭 창: 지금 프레임을 크게 띄워 확대해 픽셀 단위로 고른다 (프레임은 grabFrame으로 떠 둔 것)

/** 고른 사각형을 바꾸는 곳: 테두리·모서리(n·s·e·w 조합) 또는 안쪽(옮기기) */
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move'
const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
/** 보기: 배율(화면 px / 프레임 px)과 화면 왼쪽 위의 프레임 좌표 */
interface View { zoom: number; x: number; y: number }
type CropDrag =
  | { kind: 'pan'; x: number; y: number; view: View }
  // 새로 고르기: 누른 픽셀부터 (누르기만 하면 전에 고른 것을 그대로)
  | { kind: 'new'; ax: number; ay: number; prev: Rect | null }
  | { kind: 'edit'; handle: Handle; px: number; py: number; rect: Rect }

const MAX_ZOOM = 40
// 이 배율부터 픽셀 경계선을 그린다
const GRID_ZOOM = 8
const MIN_CROP = 8
const PREVIEW_W = 194
const PREVIEW_H = 130
const FIELD_LABEL: Record<keyof Rect, string> = { x: 'X', y: 'Y', w: '너비', h: '높이' }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 사각형을 배율대로 (프레임 안으로) */
function scaleRect(r: Rect, sx: number, sy: number, frame: { width: number; height: number }): Rect {
  const x = clamp(Math.round(r.x * sx), 0, frame.width - 1)
  const y = clamp(Math.round(r.y * sy), 0, frame.height - 1)
  return { x, y, w: clamp(Math.round(r.w * sx), 1, frame.width - x), h: clamp(Math.round(r.h * sy), 1, frame.height - y) }
}

/** 손잡이를 (x, y)로 끌었을 때 사각형: 픽셀 경계에 맞추고 프레임 안으로 */
function editRect(d: { handle: Handle; px: number; py: number; rect: Rect }, x: number, y: number, frame: { width: number; height: number }): Rect {
  const r = d.rect
  if (d.handle === 'move') {
    return { ...r, x: clamp(r.x + Math.round(x - d.px), 0, frame.width - r.w), y: clamp(r.y + Math.round(y - d.py), 0, frame.height - r.h) }
  }
  let left = r.x
  let top = r.y
  let right = r.x + r.w
  let bottom = r.y + r.h
  if (d.handle.includes('w')) left = clamp(Math.round(x), 0, right - 1)
  if (d.handle.includes('e')) right = clamp(Math.round(x), left + 1, frame.width)
  if (d.handle.includes('n')) top = clamp(Math.round(y), 0, bottom - 1)
  if (d.handle.includes('s')) bottom = clamp(Math.round(y), top + 1, frame.height)
  return { x: left, y: top, w: right - left, h: bottom - top }
}

function CropDialog({ state, crop }: { state: ImageSearchState; crop: CropTarget }) {
  const { kind, frame } = crop
  const template = state.template
  // 크롭한 영상 크기 → 이 프레임 배율 (검색 영역은 크롭한 영상 크기 기준으로 둔다)
  const sx = template ? frame.width / template.frameWidth : 1
  const sy = template ? frame.height / template.frameHeight : 1
  const dialogRef = useRef<HTMLDialogElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<CropDrag | null>(null)
  // 화면(보기 칸) 크기 · 보기(null이면 화면에 맞춤)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [view, setView] = useState<View | null>(null)
  // 고른 사각형: 처음엔 지금 크롭(같은 크기 영상일 때) 또는 지금 검색 영역
  const [sel, setSel] = useState<Rect | null>(() => {
    if (kind === 'area') return state.customArea ? scaleRect(state.customArea, sx, sy, frame) : null
    return template && template.frameWidth === frame.width && template.frameHeight === frame.height ? template.rect : null
  })
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const [space, setSpace] = useState(false)
  const [panning, setPanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
    boxRef.current?.focus()
  }, [])

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
  const v = useMemo<View | null>(
    () => view ?? (size && fit ? { zoom: fit, x: (frame.width - size.w / fit) / 2, y: (frame.height - size.h / fit) / 2 } : null),
    [view, size, fit, frame],
  )

  // 보이는 부분만 그린다: 확대하면 픽셀이 또렷하게(부드럽게 하지 않음), 크게 확대하면 픽셀 경계선
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

  // 고른 부분 미리 보기 (확대해도 픽셀 그대로)
  useLayoutEffect(() => {
    const canvas = previewRef.current
    if (!canvas || !sel) return
    const scale = Math.min(PREVIEW_W / sel.w, PREVIEW_H / sel.h, 16)
    canvas.width = Math.max(1, Math.round(sel.w * scale))
    canvas.height = Math.max(1, Math.round(sel.h * scale))
    const context = canvas.getContext('2d')
    if (!context) return
    context.imageSmoothingEnabled = scale < 1
    context.drawImage(frame.canvas, sel.x, sel.y, sel.w, sel.h, 0, 0, canvas.width, canvas.height)
  }, [frame, sel])

  /** 화면 점(cx, cy)은 그대로 두고 배율을 바꾼다 */
  const zoomAt = (zoom: number, cx: number, cy: number) => {
    if (!v) return
    const z = clamp(zoom, minZoom, MAX_ZOOM)
    setView({ zoom: z, x: v.x + cx / v.zoom - cx / z, y: v.y + cy / v.zoom - cy / z })
  }
  const zoomBy = (factor: number) => v && size && zoomAt(v.zoom * factor, size.w / 2, size.h / 2)
  /** 원래 크기 (프레임 1픽셀 = 화면 1픽셀), 화면 가운데 기준 */
  const actualSize = () => size && zoomAt(1, size.w / 2, size.h / 2)
  const zoomToSelection = () => {
    if (!sel || !size) return
    const z = clamp(Math.min(size.w / (sel.w * 1.5), size.h / (sel.h * 1.5)), minZoom, MAX_ZOOM)
    setView({ zoom: z, x: sel.x + sel.w / 2 - size.w / 2 / z, y: sel.y + sel.h / 2 - size.h / 2 / z })
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
  const toFrame = (e: React.PointerEvent<HTMLDivElement>, at: View) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: at.x + (e.clientX - r.left) / at.zoom, y: at.y + (e.clientY - r.top) / at.zoom }
  }
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!v) return
    const p = toFrame(e, v)
    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined
    if (e.button === 1 || (e.button === 0 && space)) {
      dragRef.current = { kind: 'pan', x: e.clientX, y: e.clientY, view: v }
      setPanning(true)
    } else if (e.button === 0 && handle && sel) {
      dragRef.current = { kind: 'edit', handle, px: p.x, py: p.y, rect: sel }
    } else if (e.button === 0) {
      const ax = clamp(Math.floor(p.x), 0, frame.width - 1)
      const ay = clamp(Math.floor(p.y), 0, frame.height - 1)
      dragRef.current = { kind: 'new', ax, ay, prev: sel }
      setSel({ x: ax, y: ay, w: 1, h: 1 })
    } else return
    e.preventDefault()
    e.currentTarget.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    setError(null)
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!v) return
    const p = toFrame(e, v)
    const inside = p.x >= 0 && p.y >= 0 && p.x < frame.width && p.y < frame.height
    setHover(inside ? { x: Math.floor(p.x), y: Math.floor(p.y) } : null)
    const d = dragRef.current
    if (!d) return
    if (d.kind === 'pan') {
      setView({ zoom: d.view.zoom, x: d.view.x - (e.clientX - d.x) / d.view.zoom, y: d.view.y - (e.clientY - d.y) / d.view.zoom })
    } else if (d.kind === 'new') {
      const x = clamp(Math.floor(p.x), 0, frame.width - 1)
      const y = clamp(Math.floor(p.y), 0, frame.height - 1)
      setSel({ x: Math.min(x, d.ax), y: Math.min(y, d.ay), w: Math.abs(x - d.ax) + 1, h: Math.abs(y - d.ay) + 1 })
    } else {
      setSel(editRect(d, p.x, p.y, frame))
    }
  }
  const onUp = () => {
    const d = dragRef.current
    dragRef.current = null
    setPanning(false)
    // 누르기만 했으면(끌지 않음) 전에 고른 것을 그대로
    if (d?.kind === 'new' && d.prev && sel && sel.w === 1 && sel.h === 1) setSel(d.prev)
  }

  /** 숫자 칸: 프레임 안으로만 맞추고(최소 크기는 확인할 때) */
  const setField = (key: keyof Rect, value: number) => {
    if (!sel || !Number.isFinite(value)) return
    const n = Math.round(value)
    if (key === 'x') setSel({ ...sel, x: clamp(n, 0, frame.width - sel.w) })
    if (key === 'y') setSel({ ...sel, y: clamp(n, 0, frame.height - sel.h) })
    if (key === 'w') setSel({ ...sel, w: clamp(n, 1, frame.width - sel.x) })
    if (key === 'h') setSel({ ...sel, h: clamp(n, 1, frame.height - sel.y) })
  }

  const valid = sel !== null && sel.w >= MIN_CROP && sel.h >= MIN_CROP
  const cancel = () => state.setCrop(null)
  const apply = () => {
    if (!sel || !valid) return
    if (kind === 'template') {
      try {
        const { gray, preview } = captureTemplate(frame.canvas, sel)
        state.setTemplate({ rect: sel, frameWidth: frame.width, frameHeight: frame.height, gray, preview, path: frame.path, time: frame.time })
      } catch (err) {
        return setError(`이미지를 떼어 내지 못했습니다: ${toMessage(err)}`)
      }
      state.setCustomArea(null)
      state.setAreaMode('same')
    } else {
      state.setCustomArea({ x: Math.round(sel.x / sx), y: Math.round(sel.y / sy), w: Math.round(sel.w / sx), h: Math.round(sel.h / sy) })
      state.setAreaMode('custom')
    }
    state.setCrop(null)
  }

  // 키: 방향키 1픽셀 옮기기(Shift 10) · Ctrl+방향키 크기 · Space 누른 채 끌기 = 화면 이동 · +/−/0 확대 · Enter 확인 (Esc는 패널이 받아 닫는다)
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement
    const typing = target.tagName === 'INPUT'
    if (e.code === 'Space') {
      if (typing) return
      e.preventDefault()
      if (!e.repeat) setSpace(true)
      return
    }
    if (e.key === 'Enter' && target.tagName !== 'BUTTON') {
      e.preventDefault()
      apply()
      return
    }
    if (typing) return
    if (e.key === '+' || e.key === '=') return zoomBy(2)
    if (e.key === '-') return zoomBy(0.5)
    if (e.key === '0') return setView(null)
    const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key]
    if (!dir || !sel) return
    e.preventDefault()
    const step = e.shiftKey ? 10 : 1
    const [dx, dy] = [dir[0] * step, dir[1] * step]
    if (e.ctrlKey) {
      setSel({ ...sel, w: clamp(sel.w + dx, 1, frame.width - sel.x), h: clamp(sel.h + dy, 1, frame.height - sel.y) })
    } else {
      setSel({ ...sel, x: clamp(sel.x + dx, 0, frame.width - sel.w), y: clamp(sel.y + dy, 0, frame.height - sel.h) })
    }
  }
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.code !== 'Space') return
    e.preventDefault()
    setSpace(false)
  }

  /** 프레임 픽셀 사각형 → 보기 칸 안 위치 */
  const place = (r: Rect, at: View) => ({ left: (r.x - at.x) * at.zoom, top: (r.y - at.y) * at.zoom, width: r.w * at.zoom, height: r.h * at.zoom })
  // 검색 영역을 고를 때는 크롭한 이미지 위치도 보여 준다
  const reference = kind === 'area' && template ? scaleRect(template.rect, sx, sy, frame) : null
  const name = frame.path.split(/[\\/]/).pop() ?? frame.path

  return (
    <dialog
      ref={dialogRef}
      className={`dialog rv-cropper${kind === 'area' ? ' area' : ''}`}
      aria-label={kind === 'template' ? '찾을 이미지 크롭' : '검색 영역 지정'}
      onClose={cancel}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <div className="dialog-head">
        <h2 className="ellipsis">
          {kind === 'template' ? '찾을 이미지 크롭' : '검색 영역 지정'}
          <span className="muted" translate="no">{` · ${name} · ${formatFrameTime(frame.time)} · ${frame.width}×${frame.height}`}</span>
        </h2>
        <button type="button" className="icon" aria-label="닫기" title="닫기 (Esc)" onClick={cancel}>✕</button>
      </div>
      <div className="rv-cropper-tools small">
        <button type="button" className="small-btn" disabled={!v} onClick={() => zoomBy(0.5)} title="축소 (−)">−</button>
        <span className="mono rv-cropper-zoom">{v ? `${Math.round(v.zoom * 100)}%` : ''}</span>
        <button type="button" className="small-btn" disabled={!v} onClick={() => zoomBy(2)} title="확대 (+)">+</button>
        <button type="button" className="small-btn" onClick={() => setView(null)} title="화면에 맞춤 (0)">맞춤</button>
        <button type="button" className="small-btn" disabled={!v} onClick={actualSize} title="원래 크기 (영상 1픽셀 = 화면 1픽셀)">1:1</button>
        <button type="button" className="small-btn" disabled={!sel} onClick={zoomToSelection} title="고른 부분을 크게">고른 부분 확대</button>
        <span className="rv-spacer" />
        <span className="mono muted">{hover ? `x ${hover.x} · y ${hover.y}` : ''}</span>
      </div>
      <div className="rv-cropper-main">
        <div
          ref={boxRef}
          className={`rv-cropper-view${space || panning ? ' pan' : ''}${panning ? ' panning' : ''}`}
          tabIndex={0}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={() => setHover(null)}
        >
          <canvas ref={canvasRef} />
          {v && reference && <div className="rv-cropper-ref" style={place(reference, v)} />}
          {v && sel && (
            <div className="rv-cropper-sel" data-handle="move" style={place(sel, v)}>
              <span className="rv-cropper-size mono">{`${sel.w}×${sel.h}`}</span>
              {HANDLES.map((h) => <span key={h} className={`rv-cropper-handle ${h}`} data-handle={h} />)}
            </div>
          )}
        </div>
        <aside className="rv-cropper-side small">
          <div className="rv-cropper-preview">
            {sel ? <canvas ref={previewRef} /> : <span className="muted">드래그해서 고르세요</span>}
          </div>
          <div className="rv-cropper-fields">
            {(['x', 'y', 'w', 'h'] as const).map((k) => (
              <label key={k}>
                {FIELD_LABEL[k]}
                <input type="number" value={sel?.[k] ?? ''} disabled={!sel} onChange={(e) => setField(k, e.target.valueAsNumber)} />
              </label>
            ))}
          </div>
          {sel && !valid && <p className="error">8×8 픽셀보다 크게 고르세요</p>}
          {error && <p className="error">{error}</p>}
          <ul className="rv-cropper-help muted">
            <li>드래그: 새로 고르기</li>
            <li>안쪽 끌기: 옮기기 · 테두리·모서리: 크기</li>
            <li>휠: 확대·축소 (커서 위치 기준)</li>
            <li>Space 또는 가운데 버튼 + 끌기: 화면 이동</li>
            <li>방향키: 1픽셀 옮기기 (Shift 10) · Ctrl+방향키: 크기</li>
          </ul>
          <span className="rv-spacer" />
          <div className="rv-cropper-actions">
            <button type="button" onClick={cancel}>취소</button>
            <button type="button" className="primary" disabled={!valid} onClick={apply} title="Enter">
              {kind === 'template' ? '이 부분으로 크롭' : '이 영역으로 지정'}
            </button>
          </div>
        </aside>
      </div>
    </dialog>
  )
}

// ─────────────────────────────── 패널: 설정·진행·찾은 구간

/** 찾은 구간 목록의 열: 머리글(내보내는 표의 머리글도 같음) · 화면 폭 · 가장 좁은 폭(px) · 칸 모양 */
const COLUMN_SPEC: Record<ResultColumn, { label: string; width: string; min: number; className: string }> = {
  time: { label: '시각', width: '168px', min: 168, className: '' },
  cycle: { label: 'Cycle', width: '46px', min: 46, className: 'small mono' },
  step: { label: '스텝', width: '46px', min: 46, className: 'small' },
  name: { label: '스텝 이름', width: 'minmax(72px, 1fr)', min: 72, className: 'small ellipsis' },
  offset: { label: '스텝부터(초)', width: '74px', min: 74, className: 'small muted mono rv-search-num' },
  length: { label: '길이(초)', width: '54px', min: 54, className: 'small muted mono rv-search-num' },
  peak: { label: '유사도(%)', width: '64px', min: 64, className: 'small muted mono rv-search-num' },
  frame: { label: '프레임', width: '54px', min: 54, className: 'small muted mono rv-search-num' },
  video: { label: '영상', width: 'minmax(80px, 0.7fr)', min: 80, className: 'small muted ellipsis' },
}
// 칸 사이 · 줄 양옆 여백 (CSS와 같게)
const COLUMN_GAP = 8
const ROW_PADDING = 12

/** 파일 이름에 넣을 시각 20261023_101530 */
const fileStamp = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// 슬라이드 쇼: 프레임이 이만큼 지나도 안 나오면(영상을 열지 못함) 다음 줄로
const SLIDE_WAIT_MS = 10_000

/** 초 입력 칸: 쓰는 동안은 쓴 그대로 두고(비워도 됨) 숫자면 min~max로 바로 반영, 칸을 떠나면 반영된 값을 보여 준다 */
function SecondsField({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (seconds: number) => void }) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={0.5}
      defaultValue={value}
      onChange={(e) => {
        const n = e.target.valueAsNumber
        if (Number.isFinite(n)) onChange(clamp(n, min, max))
      }}
      onBlur={(e) => {
        e.target.value = String(value)
      }}
    />
  )
}

export function ImageSearchPanel({ state, videos, steps, currentPath, videoRef, grab, escape, nowSeconds, wallOf, onSeek }: {
  state: ImageSearchState
  videos: SearchVideo[]
  /** 찾을 범위를 고른 스텝 앞뒤로 할 때 쓰는 Result 표 */
  steps: StepSource
  currentPath: string | null
  /** 영상 요소 (슬라이드 쇼: 시작하면 멈추고, 재생하면 슬라이드 쇼를 끝낸다) */
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** 크롭 창에 띄울 지금 프레임 (아직 보이는 프레임이 없으면 null) */
  grab: () => FrameShot | null
  /** Esc를 이 패널이 받을지 (자르기·저장 창이 열려 있으면 false: 그 창이 닫히게) */
  escape: boolean
  /** 지금 영상 위치(초) */
  nowSeconds: number
  /** 영상 위치 → 벽시계 ms (모르면 null): 영상 여러 개를 한 시간축에 */
  wallOf: (path: string, seconds: number) => number | null
  onSeek: (path: string, seconds: number) => void
}) {
  const { template, threshold, setThreshold, gap, setGap, found, status, error, running, segments } = state
  // 스텝 값 고르기 창 (머리글 거르기와 같은 창)
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null)
  // 슬라이드 쇼 중 (패널을 닫으면 끝)
  const [sliding, setSliding] = useState(false)
  // 크롭 창 열기: 지금 프레임을 떠서 (영상이 아직 안 보이면 안내)
  const [grabError, setGrabError] = useState<string | null>(null)
  const openCrop = (kind: CropTarget['kind']) => {
    const frame = grab()
    setGrabError(frame ? null : '영상 프레임을 아직 읽지 못했습니다. 영상이 보이면 다시 누르세요')
    if (!frame) return
    setSliding(false)
    state.setCrop({ kind, frame })
  }

  // Esc: 크롭 창 → 값 고르기 창 → 슬라이드 쇼 → 패널 닫기 순 (결과 확인 창이 닫히지 않게 먼저 받는다)
  useEffect(() => {
    if (!escape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (state.crop) state.setCrop(null)
      else if (picker) setPicker(null)
      else if (sliding) setSliding(false)
      else state.close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state, escape, picker, sliding])

  // 고른 스텝: 머리글(열) 하나를 고르고 그 열의 값으로 → 스텝 시각 앞뒤 구간 (겹치면 합침)
  const column = state.stepColumn
  const pickerValues = useMemo(() => (column === null ? [] : steps.rows.map((r) => r.cells[column] ?? '')), [steps.rows, column])
  const pickerFilter = useMemo(() => (state.stepValues.length > 0 ? { values: state.stepValues } : undefined), [state.stepValues])
  const chosen = useMemo(() => {
    if (column === null) return []
    const values = new Set(state.stepValues)
    return steps.rows.filter((r) => r.time !== null && values.has(r.cells[column] ?? ''))
  }, [steps.rows, column, state.stepValues])
  const plan = useMemo(() => stepWindows(chosen, steps, videos, state.before, state.after), [chosen, steps, videos, state.before, state.after])
  const planSeconds = plan.windows.reduce((n, w) => n + w.end - w.start, 0)
  const videoSeconds = videos.reduce((n, v) => n + (v.duration ?? 0), 0)
  const valueText = (v: string) => (column === null ? v : steps.label(column, v)) || '(빈 값)'
  const pickedText = state.stepValues.length === 0 ? '값 고르기'
    : state.stepValues.length === 1 ? valueText(state.stepValues[0])
      : `${valueText(state.stepValues[0])} 외 ${state.stepValues.length - 1}개`
  const stepScope = state.scope === 'steps'
  const rowByIndex = useMemo(() => new Map(steps.rows.map((r) => [r.index, r])), [steps.rows])
  const timedRows = useMemo(() => steps.rows.filter((r) => r.time !== null).sort((a, b) => a.time! - b.time! || a.index - b.index), [steps.rows])
  // 테스트가 끝난 시각 (마지막 스텝이 끝난 때): 그 뒤에 찾은 것은 스텝이 없다
  const runEnd = useMemo(() => timedRows.reduce((end, r) => Math.max(end, r.time! + (r.durationMs ?? 0)), -Infinity), [timedRows])
  /**
   * 찾은 구간의 스텝과 그 스텝 시각부터 몇 초 뒤인지: 고른 스텝 앞뒤로 찾았으면 가장 가까운 고른 스텝,
   * 영상 전체로 찾았으면 그때 하던 스텝 (영상 시작 시각을 몰라 벽시계를 모르면 없음)
   */
  const stepOf = (s: Segment): { row: ResultRow; offset: number } | null => {
    const t = s.first / s.fps
    if (state.searched) {
      const w = state.searched.find((x) => x.path === s.path && s.first >= Math.floor(x.start * s.fps) && t < x.end)
      const near = w?.steps.reduce((a, b) => (Math.abs(b.at - t) < Math.abs(a.at - t) ? b : a))
      const row = near ? rowByIndex.get(near.index) : undefined
      return near && row ? { row, offset: t - near.at } : null
    }
    const wall = wallOf(s.path, t)
    const row = wall === null || wall > runEnd ? null : rowAtTime(timedRows, wall)
    return wall !== null && row?.time != null ? { row, offset: (wall - row.time) / 1000 } : null
  }
  const keyOf = (s: Segment) => `${s.path}:${s.first}`
  /** 목록 한 줄의 칸 (내보내기와 같은 값, 숫자는 단위 없이) */
  const cellsOf = (s: Segment): Record<ResultColumn, string> => {
    const t = s.first / s.fps
    const wall = wallOf(s.path, t)
    const step = stepOf(s)
    return {
      // 실제 시각 (영상 시작 시각을 모르면 영상 위치)
      time: wall !== null ? formatWall(wall, true) : formatFrameTime(t),
      cycle: step?.row.cycle ?? '',
      step: step ? String(step.row.index + 1) : '',
      name: step?.row.name ?? '',
      offset: step ? step.offset.toFixed(2) : '',
      length: ((s.last - s.first + 1) / s.fps).toFixed(2),
      peak: (s.peak / 2).toFixed(1),
      frame: String(s.first),
      video: nameOf(s.path),
    }
  }
  // 열: 영상이 하나면 '영상' 열은 없다
  const columns = RESULT_COLUMNS.filter((c) => c !== 'video' || videos.length > 1)
  const toggleColumn = (c: ResultColumn) =>
    state.setExportColumns(state.exportColumns.includes(c) ? state.exportColumns.filter((x) => x !== c) : [...state.exportColumns, c])
  const [exportNotice, setExportNotice] = useState<string | null>(null)
  /** 목록·시간축에서 누름: 하이라이트하고 그 구간 첫 프레임으로 */
  const pick = (s: Segment) => {
    state.setPicked(keyOf(s))
    onSeek(s.path, (s.first + 0.5) / s.fps)
  }
  // 시간축에서 누른 구간이 목록에서 안 보이면 보이게
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    if (!state.picked) return
    listRef.current?.querySelector('li.picked')?.scrollIntoView({ block: 'nearest' })
  }, [state.picked])

  // 한 시간축: 모든 영상의 시작 시각을 알면 벽시계, 아니면 영상을 순서대로 이어 붙인다
  const axis = useMemo(() => {
    const walls = videos.map((v) => wallOf(v.path, 0))
    const useWall = walls.every((w) => w !== null)
    const spans: { path: string; name: string; begin: number; end: number }[] = []
    videos.forEach((v, i) => {
      const f = found.find((x) => x.path === v.path)
      const seconds = v.duration ?? (f && f.fps ? f.scores.length / f.fps : 0)
      const begin = useWall ? walls[i]! / 1000 : (spans.at(-1)?.end ?? 0)
      spans.push({ path: v.path, name: v.name, begin, end: begin + seconds })
    })
    const min = Math.min(...spans.map((s) => s.begin))
    const max = Math.max(...spans.map((s) => s.end))
    return { useWall, spans, min, length: Math.max(1, max - min) }
  }, [videos, found, wallOf])
  /** 영상 위치 → 시간축 위치(%) */
  const posOf = useCallback((path: string, seconds: number) => {
    const span = axis.spans.find((s) => s.path === path)
    return span ? ((span.begin + seconds - axis.min) / axis.length) * 100 : 0
  }, [axis])
  const ordered = useMemo(
    () => [...segments].sort((a, b) => posOf(a.path, a.first / a.fps) - posOf(b.path, b.first / b.fps)),
    [segments, posOf],
  )

  // 슬라이드 쇼: 누른 줄부터 목록 차례로 첫 프레임을 slideSeconds초씩 (영상은 멈춘 채, 끝 줄에서 멈춤).
  // 시간은 그 프레임이 화면에 나온 뒤부터 센다 (테스트 PC에서 받는 영상은 옮겨 가는 데 시간이 걸린다). 줄을 누르면 거기서 이어 간다
  const slideIndex = sliding ? ordered.findIndex((s) => keyOf(s) === state.picked) : -1
  const slide = slideIndex >= 0 ? ordered[slideIndex] : null
  // 찾는 중에는 목록을 계속 다시 만들므로 구간 객체 대신 키로 본다
  const slideKey = slide ? keyOf(slide) : null
  const shown = slide !== null && slide.path === currentPath && Math.abs(nowSeconds - (slide.first + 0.5) / slide.fps) < 0.5 / slide.fps
  const nextSlide = useEffectEvent(() => {
    const i = ordered.findIndex((s) => keyOf(s) === state.picked)
    if (i < 0 || i === ordered.length - 1) setSliding(false)
    else pick(ordered[i + 1])
  })
  useEffect(() => {
    if (!sliding) return
    // 보던 줄이 목록에서 없어졌으면(다시 찾음·기준 바꿈) 바로 끝
    const id = window.setTimeout(nextSlide, slideKey === null ? 0 : shown ? state.slideSeconds * 1000 : SLIDE_WAIT_MS)
    return () => window.clearTimeout(id)
  }, [sliding, slideKey, shown, state.slideSeconds])
  // 영상을 재생하면 슬라이드 쇼는 끝 (Space·▶)
  useEffect(() => {
    if (!sliding) return
    const onPlay = (e: Event) => {
      if (e.target === videoRef.current) setSliding(false)
    }
    window.addEventListener('play', onPlay, true)
    return () => window.removeEventListener('play', onPlay, true)
  }, [sliding, videoRef])
  const toggleSlides = () => {
    if (sliding) return setSliding(false)
    if (ordered.length === 0) return
    const i = ordered.findIndex((s) => keyOf(s) === state.picked)
    videoRef.current?.pause()
    // 마지막 줄을 보고 있었으면 처음부터
    pick(ordered[i >= 0 && i < ordered.length - 1 ? i : 0])
    setSliding(true)
  }
  // 내보내기: 머리글에서 체크한 열만, 목록과 같은 차례
  const canExport = ordered.length > 0 && columns.some((c) => state.exportColumns.includes(c))
  const exportLines = () => {
    const chosen = columns.filter((c) => state.exportColumns.includes(c))
    // 머리글은 화면 언어로 (English면 영어)
    return [chosen.map((c) => tr(COLUMN_SPEC[c].label)), ...ordered.map((s) => {
      const v = cellsOf(s)
      return chosen.map((c) => v[c])
    })]
  }
  const exportXlsx = () => {
    const name = (videos[0]?.name ?? '영상').replace(/\.[^.]+$/, '')
    downloadXlsx(`이미지찾기_${name}_${fileStamp(new Date())}.xlsx`, tr('이미지 찾기'), exportLines())
  }
  const copyRows = () => {
    copyTable(exportLines())
    setExportNotice('표를 복사했습니다 (엑셀에 붙여 넣기)')
    window.setTimeout(() => setExportNotice(null), 2500)
  }
  const nameOf = (path: string) => videos.find((v) => v.path === path)?.name ?? path
  const area = areaOf(state)
  // 직접 지정한 영역 크기 (크롭한 영상 픽셀)
  const areaText = state.areaMode === 'custom' && state.customArea ? `${state.customArea.w}×${state.customArea.h}` : ''

  return (
    <div className="rv-search">
      {/* 옵션 두 줄 (좁으면 무리 단위로 줄바꿈): 찾을 이미지·검색 영역·유사도·끊김·찾기 | 찾을 범위 */}
      <div className="rv-search-bar">
        <strong title={`이 실행의 영상 ${videos.length}개에서 크롭한 이미지가 나타나는 구간의 첫 프레임`}>이미지 찾기</strong>
        <span className="rv-search-group">
          {template
            ? (
              <img
                className="rv-search-thumb"
                src={template.preview}
                alt=""
                title={`크롭: ${template.rect.w}×${template.rect.h} · ${template.path.split(/[\\/]/).pop()} ${formatFrameTime(template.time)}`}
              />
            )
            : <span className="muted small">[크롭]으로 고르기</span>}
          <button type="button" onClick={() => openCrop('template')} title="지금 프레임을 크게 띄워 찾을 이미지를 고릅니다 (확대해 픽셀 단위로)">
            {template ? '다시 크롭' : '크롭'}
          </button>
        </span>
        <span className="rv-search-group">
          <label className="small" title="이 영역 안에서 크롭한 이미지와 비슷한 곳을 찾습니다">
            검색 영역
            <select
              value={state.areaMode}
              disabled={!template}
              onChange={(e) => {
                const mode = e.target.value as AreaMode
                state.setAreaMode(mode)
                if (mode === 'custom' && !state.customArea) openCrop('area')
              }}
            >
              <option value="same">크롭 위치 그대로</option>
              <option value="custom">직접 지정</option>
              <option value="full">화면 전체</option>
            </select>
          </label>
          {state.areaMode === 'custom' && (
            <button type="button" disabled={!template} onClick={() => openCrop('area')} title="지금 프레임을 크게 띄워 검색할 영역을 고릅니다">
              영역 지정
            </button>
          )}
          {template && areaText && <span className="muted small mono">{areaText}</span>}
        </span>
        <label className="small" title="이 값 이상이면 나타난 것으로 봅니다. 바꾸면 다시 찾지 않고 바로 다시 나눕니다">
          유사도
          <input type="range" min={50} max={100} step={0.5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          <span className="mono">{threshold.toFixed(1)}%</span>
        </label>
        <label className="small" title="기준 아래로 이 시간 이하 끊긴 것은 한 번 나타난 것으로 봅니다 (깜빡임·인코딩 잡음)">
          끊김 무시
          <select value={gap} onChange={(e) => setGap(Number(e.target.value))}>
            {[0, 0.1, 0.3, 0.5, 1, 2].map((g) => <option key={g} value={g}>{g}초</option>)}
          </select>
        </label>
        <span className="rv-search-go">
          {running
            ? <button type="button" onClick={state.stop}>멈춤</button>
            : (
              <button
                type="button"
                className="primary"
                disabled={!area || videos.length === 0 || state.crop !== null || (stepScope && plan.windows.length === 0)}
                onClick={() => area && void state.run(area, stepScope ? plan.windows : undefined)}
              >
                찾기
              </button>
            )}
          <button type="button" className="icon" aria-label="닫기" title="닫기 (Esc)" onClick={state.close}>✕</button>
        </span>
      </div>
      <div className="rv-search-bar">
        <label className="small" title="영상 전체를 훑거나, 고른 스텝의 앞뒤 몇 초만 훑습니다 (훨씬 빠름)">
          찾을 범위
          <select value={state.scope} onChange={(e) => state.setScope(e.target.value as SearchScope)}>
            <option value="all">영상 전체</option>
            <option value="steps">고른 스텝 앞뒤</option>
          </select>
        </label>
        {stepScope && (
          <>
            <select
              value={column ?? ''}
              title="스텝을 고를 머리글"
              onChange={(e) => {
                state.setStepColumn(e.target.value === '' ? null : Number(e.target.value))
                state.setStepValues([])
                setPicker(null)
              }}
            >
              <option value="">머리글 고르기</option>
              {steps.headers.map((h, i) => <option key={i} value={i}>{h || `열 ${i + 1}`}</option>)}
            </select>
            <button
              type="button"
              className="rv-search-pick"
              data-colfilter-trigger
              disabled={column === null}
              title="이 머리글의 값 중에서 찾을 스텝 고르기"
              onClick={(e) => {
                if (picker) return setPicker(null)
                const r = e.currentTarget.getBoundingClientRect()
                setPicker({ x: r.left, y: r.bottom + 2 })
              }}
            >
              <span className="ellipsis">{pickedText}</span> ▾
            </button>
            <span className="rv-search-group">
              <label className="small" title="스텝 시각보다 이만큼 앞부터">
                앞
                <SecondsField value={state.before} min={0} max={3600} onChange={state.setBefore} />
                초
              </label>
              <label className="small" title="스텝 시각보다 이만큼 뒤까지">
                뒤
                <SecondsField value={state.after} min={0} max={3600} onChange={state.setAfter} />
                초
              </label>
            </span>
          </>
        )}
        <span className="rv-search-plan small muted">
          {!stepScope ? <span>{`영상 ${videos.length}개${videoSeconds > 0 ? ` · ${formatDuration(videoSeconds * 1000)}` : ''}`}</span>
            : column === null ? <span>머리글을 고르고, 그 열의 값 중에서 찾을 스텝을 고르세요</span>
              : chosen.length === 0 ? <span>찾을 스텝의 값을 고르세요</span>
                : (
                  <>
                    <span>{`스텝 ${chosen.length}개 → 구간 ${plan.windows.length}개 · ${formatDuration(planSeconds * 1000)}`}</span>
                    {videoSeconds > 0 && <span>{`영상의 ${((planSeconds / videoSeconds) * 100).toFixed(1)}%`}</span>}
                    {plan.outside > 0 && <span className="rv-search-warn" title="영상 시작 시각을 모르거나 영상 밖의 스텝">{`영상 밖 ${plan.outside}개 뺌`}</span>}
                  </>
                )}
        </span>
      </div>
      {running && (
        <div className="small muted">
          <progress max={1} value={status?.progress ?? 0} />{' '}
          {`찾는 중 ${Math.round((status?.progress ?? 0) * 100)}%`}{status?.current ? ` · ${status.current}` : ''}
          {status && status.scale > 1 && ` · 영역이 넓어 1/${status.scale}로 훑은 뒤 원래 크기로 확인`}
        </div>
      )}
      {running && state.retrying && <p className="small muted">테스트 PC 연결이 잠깐 끊겨 다시 묻는 중… (찾기는 테스트 PC에서 계속됩니다)</p>}
      {grabError && <p className="error small">{grabError}</p>}
      {error && <p className="error small">{error}</p>}
      {found.filter((f) => f.error).map((f) => <p key={f.path} className="error small">{`${nameOf(f.path)}: ${f.error}`}</p>)}
      {found.length > 0 && (
        <>
          <div className="rv-search-axis" title="이 실행의 영상 전체 (누르면 그 구간으로 이동)">
            {axis.spans.map((s) => (
              <div
                key={s.path}
                className={`rv-search-span${s.path === currentPath ? ' current' : ''}`}
                style={{ left: `${((s.begin - axis.min) / axis.length) * 100}%`, width: `${((s.end - s.begin) / axis.length) * 100}%` }}
                title={s.name}
              />
            ))}
            {state.searched?.map((w, i) => {
              const left = posOf(w.path, w.start)
              return <div key={`w${i}`} className="rv-search-window" style={{ left: `${left}%`, width: `max(2px, ${posOf(w.path, w.end) - left}%)` }} />
            })}
            {ordered.map((s) => (
              <button
                key={keyOf(s)}
                type="button"
                className={`rv-search-hit${keyOf(s) === state.picked ? ' picked' : ''}`}
                style={{ left: `${posOf(s.path, s.first / s.fps)}%`, width: `max(3px, ${((s.last - s.first + 1) / s.fps / axis.length) * 100}%)` }}
                title={`${nameOf(s.path)} ${formatFrameTime(s.first / s.fps)}`}
                onClick={() => pick(s)}
              />
            ))}
            {currentPath && <div className="rv-search-now" style={{ left: `${posOf(currentPath, nowSeconds)}%` }} />}
          </div>
          <div className="rv-search-summary small">
            <span className="muted">{`찾은 구간 ${ordered.length}개`}{running ? ' (찾는 중)' : ''}{' · 누르면 그 구간의 첫 프레임으로 이동'}</span>
            <span className="rv-spacer" />
            <span className="rv-search-slide">
              <button
                type="button"
                className={`small-btn${sliding ? ' active' : ''}`}
                disabled={!sliding && ordered.length === 0}
                onClick={toggleSlides}
                title={sliding ? '슬라이드 쇼 멈춤 (Esc)' : '찾은 프레임을 목록 차례로 한 장씩 보여 줍니다 (누른 줄부터)'}
              >
                {sliding ? '❚❚' : '▶'} 슬라이드 쇼
              </button>
              <label title="한 장을 보여 주는 시간 (프레임이 화면에 나온 뒤부터)">
                <SecondsField value={state.slideSeconds} min={0.5} max={60} onChange={state.setSlideSeconds} />
                초
              </label>
              {slide && <span className="mono muted">{`${slideIndex + 1}/${ordered.length}`}</span>}
            </span>
            {exportNotice && <span className="muted">{exportNotice}</span>}
            <button type="button" className="small-btn" disabled={!canExport} onClick={exportXlsx} title="머리글에서 체크한 열만 엑셀 파일(.xlsx)로">
              엑셀로 내보내기
            </button>
            <button type="button" className="small-btn" disabled={!canExport} onClick={copyRows} title="머리글에서 체크한 열만 표로 복사 (엑셀에 붙이면 칸마다)">
              표 복사
            </button>
          </div>
          {/* 머리글 있는 표: 체크한 열만 내보낸다 */}
          <ol
            className="rv-search-list"
            ref={listRef}
            style={{
              '--search-cols': columns.map((c) => COLUMN_SPEC[c].width).join(' '),
              // 줄마다 같은 폭이어야 칸이 맞는다: 패널이 좁으면 이 폭에서 가로로 스크롤
              '--search-min': `${columns.reduce((sum, c) => sum + COLUMN_SPEC[c].min, 0) + COLUMN_GAP * (columns.length - 1) + ROW_PADDING}px`,
            } as React.CSSProperties}
          >
            <li className="rv-search-head">
              {columns.map((c) => {
                const on = state.exportColumns.includes(c)
                return (
                  <label key={c} className={on ? '' : 'off'} title={on ? '내보낼 열 (누르면 뺌)' : '내보내지 않는 열 (누르면 넣음)'}>
                    <input type="checkbox" checked={on} onChange={() => toggleColumn(c)} />
                    {COLUMN_SPEC[c].label}
                  </label>
                )
              })}
            </li>
            {ordered.map((s) => {
              const key = keyOf(s)
              const v = cellsOf(s)
              return (
                <li key={key} className={key === state.picked ? 'picked' : ''} onClick={() => pick(s)}>
                  {columns.map((c) => {
                    // 내보내지 않는 열은 흐리게
                    const off = state.exportColumns.includes(c) ? '' : ' off'
                    return c === 'time'
                      ? <button key={c} type="button" className={`link mono${off}`}>{v.time}</button>
                      : (
                        <span key={c} className={COLUMN_SPEC[c].className + off} title={c === 'name' || c === 'video' ? v[c] : undefined}>
                          {c === 'step' && v.step ? `#${v.step}` : c === 'offset' && v.offset && !v.offset.startsWith('-') ? `+${v.offset}` : v[c]}
                        </span>
                      )
                  })}
                </li>
              )
            })}
          </ol>
        </>
      )}
      {state.crop && <CropDialog state={state} crop={state.crop} />}
      {picker && column !== null && (
        <ColumnFilterMenu
          x={picker.x}
          y={picker.y}
          title={steps.headers[column] || `열 ${column + 1}`}
          values={pickerValues}
          label={(v) => steps.label(column, v)}
          filter={pickerFilter}
          onApply={(f) => state.setStepValues(f?.values ?? [])}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
