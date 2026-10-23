import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clamp, formatFrameTime } from './frameUtil'
import type { FrameShot, Rect } from './imageSearchState'
import { type PickerView, type PickerViewState, usePickerView } from './pickerView'

// 영역 고르기 창 (직사각형): 지금 프레임을 크게 띄워 확대해 픽셀 단위로 사각형을 고른다 (프레임은 grabFrame으로 떠 둔 것).
// 이미지 찾기(찾을 이미지 크롭·검색 영역)가 쓴다. 꼭짓점을 하나씩 옮기는 사각형(영상 분석의 화면·베젤)은 QuadPicker,
// 보기 칸(확대·이동·그리기)은 pickerView

/** 고른 사각형을 바꾸는 곳: 테두리·모서리(n·s·e·w 조합) 또는 안쪽(옮기기) */
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move'
const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
type CropDrag =
  // 새로 고르기: 누른 픽셀부터 (누르기만 하면 전에 고른 것을 그대로)
  | { kind: 'new'; ax: number; ay: number; prev: Rect | null }
  | { kind: 'edit'; handle: Handle; px: number; py: number; rect: Rect }

const MIN_CROP = 8
const PREVIEW_W = 194
const PREVIEW_H = 130
const FIELD_LABEL: Record<keyof Rect, string> = { x: 'X', y: 'Y', w: '너비', h: '높이' }

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

/** 프레임 픽셀 사각형 → 보기 칸 안 위치 */
const placeRect = (r: Rect, at: PickerView) => ({ left: (r.x - at.x) * at.zoom, top: (r.y - at.y) * at.zoom, width: r.w * at.zoom, height: r.h * at.zoom })

/** 창 머리: 제목 · 영상 이름·위치·크기 · 닫기 */
export function PickerHead({ title, frame, onClose }: { title: string; frame: FrameShot; onClose: () => void }) {
  const name = frame.path.split(/[\\/]/).pop() ?? frame.path
  return (
    <div className="dialog-head">
      <h2 className="ellipsis">
        {title}
        <span className="muted" translate="no">{` · ${name} · ${formatFrameTime(frame.time)} · ${frame.width}×${frame.height}`}</span>
      </h2>
      <button type="button" className="icon" aria-label="닫기" title="닫기 (Esc)" onClick={onClose}>✕</button>
    </div>
  )
}

/** 도구 줄: 축소 · 배율 · 확대 · 맞춤 · 1:1 · 고른 부분 확대 · 커서 픽셀 좌표 */
export function PickerTools({ view, selection }: { view: PickerViewState; selection: Rect | null }) {
  const v = view.v
  return (
    <div className="rv-cropper-tools small">
      <button type="button" className="small-btn" disabled={!v} onClick={() => view.zoomBy(0.5)} title="축소 (−)">−</button>
      <span className="mono rv-cropper-zoom">{v ? `${Math.round(v.zoom * 100)}%` : ''}</span>
      <button type="button" className="small-btn" disabled={!v} onClick={() => view.zoomBy(2)} title="확대 (+)">+</button>
      <button type="button" className="small-btn" onClick={() => view.setView(null)} title="화면에 맞춤 (0)">맞춤</button>
      <button type="button" className="small-btn" disabled={!v} onClick={view.actualSize} title="원래 크기 (영상 1픽셀 = 화면 1픽셀)">1:1</button>
      <button type="button" className="small-btn" disabled={!selection} onClick={() => selection && view.zoomTo(selection)} title="고른 부분을 크게">고른 부분 확대</button>
      <span className="rv-spacer" />
      <span className="mono muted">{view.hover ? `x ${view.hover.x} · y ${view.hover.y}` : ''}</span>
    </div>
  )
}

export function RectPickerDialog({ frame, title, confirmLabel, initial, reference, variant = 'template', onApply, onCancel }: {
  frame: FrameShot
  title: string
  confirmLabel: string
  /** 처음 선택 (프레임 픽셀) */
  initial: Rect | null
  /** 함께 보여 줄 사각형 (프레임 픽셀): 검색 영역을 고를 때 크롭 위치 */
  reference?: Rect | null
  /** 선택 테두리: template 주황 · area 파랑 */
  variant?: 'template' | 'area'
  /** 확인: 문제가 있으면 안내 문구를 돌려준다 (창을 닫지 않고 보여 줌) */
  onApply: (rect: Rect) => string | null
  onCancel: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<CropDrag | null>(null)
  const view = usePickerView(frame)
  const { v, boxRef, canvasRef, space, panning, setHover, startPan, movePan, endPan, toFrame, viewKeyDown, viewKeyUp } = view
  const [sel, setSel] = useState<Rect | null>(initial)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
    boxRef.current?.focus()
  }, [boxRef])

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

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = toFrame(e)
    if (!p) return
    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined
    if (startPan(e)) {
      // 화면 이동
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
    if (movePan(e)) return
    const d = dragRef.current
    const p = toFrame(e)
    if (!d || !p) return
    if (d.kind === 'new') {
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
    endPan()
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
  const apply = () => {
    if (!sel || !valid) return
    const problem = onApply(sel)
    if (problem) setError(problem)
  }

  // 키: 방향키 1픽셀 옮기기(Shift 10) · Ctrl+방향키 크기 · Space 누른 채 끌기 = 화면 이동 · +/−/0 확대 · Enter 확인 (Esc는 패널이 받아 닫는다)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (viewKeyDown(e)) return
    const target = e.target as HTMLElement
    if (e.key === 'Enter' && target.tagName !== 'BUTTON') {
      e.preventDefault()
      apply()
      return
    }
    if (target.tagName === 'INPUT') return
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

  return (
    <dialog
      ref={dialogRef}
      className={`dialog rv-cropper${variant === 'template' ? '' : ` ${variant}`}`}
      aria-label={title}
      onClose={onCancel}
      onKeyDown={onKeyDown}
      onKeyUp={viewKeyUp}
    >
      <PickerHead title={title} frame={frame} onClose={onCancel} />
      <PickerTools view={view} selection={sel} />
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
          {v && reference && <div className="rv-cropper-ref" style={placeRect(reference, v)} />}
          {v && sel && (
            <div className="rv-cropper-sel" data-handle="move" style={placeRect(sel, v)}>
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
            <button type="button" onClick={onCancel}>취소</button>
            <button type="button" className="primary" disabled={!valid} onClick={apply} title="Enter">{confirmLabel}</button>
          </div>
        </aside>
      </div>
    </dialog>
  )
}
