import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { clamp, convexQuad, type Point, quadContains, squareToQuad } from './frameUtil'
import type { FrameShot, Rect } from './imageSearchState'
import { usePickerView } from './pickerView'
import { PickerHead, PickerTools } from './RectPicker'

// 영역 고르기 창 (꼭짓점): 비스듬히 찍힌 화면에 맞춰 네 꼭짓점을 하나씩 옮긴다 (영상 분석의 화면 영역).
// 드래그하면 직사각형으로 시작하고 꼭짓점을 끌어 사다리꼴로 맞춘다. 미리 보기는 반듯하게 편 모습 (에이전트도 이렇게 펴서 잰다).
// 보기 칸(확대·이동·그리기)은 pickerView, 창 머리·도구 줄은 RectPicker와 같다

type QuadDrag =
  // 새로 고르기: 누른 점부터 직사각형 (끌지 않으면 그대로)
  | { kind: 'new'; ax: number; ay: number }
  | { kind: 'corner'; index: number }
  | { kind: 'move'; px: number; py: number; pts: Point[] }

const MIN_SIDE = 8
const PREVIEW_W = 194
const PREVIEW_H = 130
const CORNER_LABEL = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래']

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])
/** 편 크기: 마주 보는 변 길이의 평균 */
const sidesOf = (p: Point[]) => ({ w: (dist(p[0], p[1]) + dist(p[3], p[2])) / 2, h: (dist(p[0], p[3]) + dist(p[1], p[2])) / 2 })
/** 둘레 직사각형 */
function boundsOf(p: Point[]): Rect {
  const xs = p.map((q) => q[0])
  const ys = p.map((q) => q[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export function QuadPickerDialog({ frame, title, confirmLabel, initial, onApply, onCancel }: {
  frame: FrameShot
  title: string
  confirmLabel: string
  /** 처음 꼭짓점 넷 (프레임 픽셀, 왼쪽 위부터 시계 방향) */
  initial: Point[] | null
  /** 확인: 문제가 있으면 안내 문구를 돌려준다 (창을 닫지 않고 보여 줌) */
  onApply: (corners: Point[]) => string | null
  onCancel: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<QuadDrag | null>(null)
  const view = usePickerView(frame)
  const { v, boxRef, canvasRef, size, space, panning, setHover, startPan, movePan, endPan, toFrame, viewKeyDown, viewKeyUp } = view
  const [pts, setPts] = useState<Point[] | null>(initial)
  // 방향키로 옮길 꼭짓점 (없으면 사각형 전체)
  const [active, setActive] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
    boxRef.current?.focus()
  }, [boxRef])

  // 프레임 픽셀 (편 미리 보기에서 한 번만 읽는다, 읽기용 캔버스에 옮겨서)
  const pixels = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = frame.width
    canvas.height = frame.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(frame.canvas, 0, 0)
    return context.getImageData(0, 0, frame.width, frame.height)
  }, [frame])

  const convex = pts !== null && convexQuad(pts)
  const sides = pts ? sidesOf(pts) : null
  const big = sides !== null && sides.w >= MIN_SIDE && sides.h >= MIN_SIDE
  const valid = convex && big

  // 반듯하게 편 미리 보기 (에이전트가 perspective로 펴는 것과 같은 모양)
  useLayoutEffect(() => {
    const canvas = previewRef.current
    if (!canvas || !pts || !pixels || !convexQuad(pts)) return
    const { w: sw, h: sh } = sidesOf(pts)
    const scale = Math.min(PREVIEW_W / Math.max(sw, 1), PREVIEW_H / Math.max(sh, 1), 16)
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext('2d')
    if (!context) return
    const out = context.createImageData(w, h)
    const map = squareToQuad(pts)
    const src = pixels.data
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [sx, sy] = map((x + 0.5) / w, (y + 0.5) / h)
        const o = (clamp(Math.floor(sy), 0, frame.height - 1) * frame.width + clamp(Math.floor(sx), 0, frame.width - 1)) * 4
        const d = (y * w + x) * 4
        out.data[d] = src[o]
        out.data[d + 1] = src[o + 1]
        out.data[d + 2] = src[o + 2]
        out.data[d + 3] = 255
      }
    }
    context.putImageData(out, 0, 0)
  }, [pts, pixels, frame])

  /** 프레임 안 점 (픽셀 경계) */
  const snap = (x: number, y: number): Point => [clamp(Math.round(x), 0, frame.width), clamp(Math.round(y), 0, frame.height)]
  /** 사각형 전체를 옮긴다 (꼭짓점이 모두 프레임 안에 남게) */
  const shift = (from: Point[], dx: number, dy: number): Point[] => {
    const b = boundsOf(from)
    const mx = clamp(dx, -b.x, frame.width - (b.x + b.w))
    const my = clamp(dy, -b.y, frame.height - (b.y + b.h))
    return from.map(([x, y]) => [x + mx, y + my])
  }

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = toFrame(e)
    if (!p) return
    const corner = (e.target as HTMLElement).dataset.corner
    if (startPan(e)) {
      // 화면 이동
    } else if (e.button === 0 && corner !== undefined && pts) {
      dragRef.current = { kind: 'corner', index: Number(corner) }
      setActive(Number(corner))
    } else if (e.button === 0 && pts && convexQuad(pts) && quadContains(pts, [[p.x, p.y]])) {
      dragRef.current = { kind: 'move', px: p.x, py: p.y, pts }
      setActive(null)
    } else if (e.button === 0) {
      const [ax, ay] = snap(p.x, p.y)
      dragRef.current = { kind: 'new', ax, ay }
    } else return
    e.preventDefault()
    e.currentTarget.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    setError(null)
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (movePan(e)) return
    const d = dragRef.current
    const p = toFrame(e)
    if (!d || !p) return
    const [x, y] = snap(p.x, p.y)
    if (d.kind === 'new') {
      if (x === d.ax || y === d.ay) return
      const [x0, x1] = [Math.min(x, d.ax), Math.max(x, d.ax)]
      const [y0, y1] = [Math.min(y, d.ay), Math.max(y, d.ay)]
      setPts([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
      setActive(null)
    } else if (d.kind === 'corner' && pts) {
      setPts(pts.map((q, i) => (i === d.index ? [x, y] : q)))
    } else if (d.kind === 'move') {
      setPts(shift(d.pts, Math.round(p.x - d.px), Math.round(p.y - d.py)))
    }
  }
  const onUp = () => {
    dragRef.current = null
    endPan()
  }

  /** 숫자 칸: 꼭짓점 하나의 X·Y (프레임 안으로) */
  const setCoord = (index: number, axis: 0 | 1, value: number) => {
    if (!pts || !Number.isFinite(value)) return
    setPts(pts.map((q, i) => (i !== index ? q : axis === 0 ? [clamp(Math.round(value), 0, frame.width), q[1]] : [q[0], clamp(Math.round(value), 0, frame.height)])))
  }

  const apply = () => {
    if (!pts || !valid) return
    const problem = onApply(pts)
    if (problem) setError(problem)
  }

  // 키: 1~4 꼭짓점 고르기 · 방향키 1픽셀(Shift 10) — 고른 꼭짓점, 안 고르면 사각형 전체 · Space 끌기 = 화면 이동 · +/−/0 · Enter 확인
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (viewKeyDown(e)) return
    const target = e.target as HTMLElement
    if (e.key === 'Enter' && target.tagName !== 'BUTTON') {
      e.preventDefault()
      apply()
      return
    }
    if (target.tagName === 'INPUT' || !pts) return
    if (['1', '2', '3', '4'].includes(e.key)) {
      const index = Number(e.key) - 1
      setActive(active === index ? null : index)
      return
    }
    const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key]
    if (!dir) return
    e.preventDefault()
    const step = e.shiftKey ? 10 : 1
    if (active === null) setPts(shift(pts, dir[0] * step, dir[1] * step))
    else setPts(pts.map((q, i) => (i === active ? snap(q[0] + dir[0] * step, q[1] + dir[1] * step) : q)))
  }

  /** 프레임 픽셀 → 보기 칸 안 위치 */
  const toView = (q: Point): Point => (v ? [(q[0] - v.x) * v.zoom, (q[1] - v.y) * v.zoom] : [0, 0])
  const line = (p: Point[]) => p.map((q) => toView(q).join(',')).join(' ')

  return (
    <dialog
      ref={dialogRef}
      className="dialog rv-cropper screen"
      aria-label={title}
      onClose={onCancel}
      onKeyDown={onKeyDown}
      onKeyUp={viewKeyUp}
    >
      <PickerHead title={title} frame={frame} onClose={onCancel} />
      <PickerTools view={view} selection={pts ? boundsOf(pts) : null} />
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
          {v && size && (
            <svg className="rv-quad-svg" width={size.w} height={size.h}>
              {pts && <path className="rv-quad-dim" fillRule="evenodd" d={`M0 0H${size.w}V${size.h}H0Z M${line(pts).replaceAll(' ', 'L')}Z`} />}
              {pts && <polygon className="rv-quad-line" points={line(pts)} />}
            </svg>
          )}
          {v && pts && sides && (
            <span className="rv-quad-size mono" style={{ left: toView(pts[0])[0], top: toView(pts[0])[1] - 8 }}>
              {`${Math.round(sides.w)}×${Math.round(sides.h)}`}
            </span>
          )}
          {v && pts && pts.map((q, i) => {
            const [left, top] = toView(q)
            return <span key={i} className={`rv-quad-corner${i === active ? ' on' : ''}`} data-corner={i} style={{ left, top }} title={CORNER_LABEL[i]} />
          })}
        </div>
        <aside className="rv-cropper-side small">
          <div className="rv-cropper-preview" title="반듯하게 편 모습 (이렇게 펴서 잽니다)">
            {pts && convex ? <canvas ref={previewRef} /> : <span className="muted">드래그해서 고르세요</span>}
          </div>
          <div className="rv-quad-fields">
            <span />
            <span className="muted">X</span>
            <span className="muted">Y</span>
            {CORNER_LABEL.map((label, i) => (
              <span key={label} className="rv-quad-row">
                <button type="button" className={`link${i === active ? ' on' : ''}`} disabled={!pts} onClick={() => setActive(active === i ? null : i)}>
                  {label}
                </button>
                {([0, 1] as const).map((axis) => (
                  <input key={axis} type="number" value={pts?.[i][axis] ?? ''} disabled={!pts} onChange={(e) => setCoord(i, axis, e.target.valueAsNumber)} />
                ))}
              </span>
            ))}
          </div>
          {pts && !convex && <p className="error">꼭짓점 차례가 꼬였습니다. 볼록한 사각형이 되게 옮기세요</p>}
          {pts && convex && !big && <p className="error">8×8 픽셀보다 크게 고르세요</p>}
          {error && <p className="error">{error}</p>}
          <ul className="rv-cropper-help muted">
            <li>드래그: 새로 고르기 (직사각형)</li>
            <li>꼭짓점 끌기: 비스듬한 화면에 맞추기 · 안쪽 끌기: 옮기기</li>
            <li>1~4 또는 꼭짓점 누르기 + 방향키: 그 꼭짓점 1픽셀 (Shift 10), 안 고르면 전체</li>
            <li>휠: 확대·축소 (커서 위치 기준)</li>
            <li>Space 또는 가운데 버튼 + 끌기: 화면 이동</li>
          </ul>
          <span className="rv-spacer" />
          <div className="rv-cropper-actions">
            <button type="button" onClick={onCancel}>취소</button>
            <button type="button" className="primary" disabled={!valid} onClick={apply} title="Enter">{confirmLabel}</button>
          </div>
        </aside>
      </div>
    </dialog>
  )
}
