import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatDuration } from '../../format'
import { type Box, boxToRect, formatFrameTime, rectToBox, useVideoView } from './frameUtil'
import type { FrameShot, Rect, SearchVideo, StepSource } from './imageSearchState'
import { RectPickerDialog } from './RectPicker'
import { formatWall, type ResultRow, statusTone } from './resultCsv'
import { rowAtTime } from './sync'
import type { RoiMode, VideoAnalysisState, VideoFrames } from './videoAnalysisState'
import { bisectLeft, type DetectedSegment, type DetectResult, type SegmentKind } from './videoDetect'

// 결과 확인 영상 분석 화면 (ReplayKit_FailAnalyzer 영상 페이지의 영상 분석을 옮김):
// 영상 위 화면 영역·베젤 표시(AnalysisOverlay) · 설정·진행·그래프(AnalysisChart)·검출 목록(VideoAnalysisPanel).
// 상태·받기는 videoAnalysisState, 판정은 videoDetect

type Tab = 'overview' | SegmentKind | 'transitions'
const TABS: [Tab, string][] = [['overview', '개요'], ['black_screen', '검은 화면'], ['flicker', '깜박임'], ['static', '정지 구간'], ['transitions', '화면 전환']]
const SEG_COLOR: Record<SegmentKind, string> = {
  black_screen: 'rgba(201, 57, 47, 0.35)', flicker: 'rgba(183, 121, 31, 0.4)', static: 'rgba(120, 130, 145, 0.22)',
}
const BRIGHT_COLOR = '#2f6fde'
const BEZEL_COLOR = '#8a8f98'
const TRANSITION_COLOR = '#8e44ad'
// 그래프 높이 (아래 평균 색 띠 포함) · 색 띠 높이
const CHART_H = 120
const STRIP_H = 10
// 목록은 이만큼씩 그린다 ("더 보기")
const LIST_PAGE = 500
// 검출 항목을 누르면 이만큼 앞부터 재생 (그 순간을 보게)
const LEAD_S = 1.5

/** 비율 사각형 글: 왼쪽 위 ~ 오른쪽 아래 (%) */
const boxText = (b: Box) => `${(b[0] * 100).toFixed(0)}%, ${(b[1] * 100).toFixed(0)}% ~ ${(b[2] * 100).toFixed(0)}%, ${(b[3] * 100).toFixed(0)}%`

// ─────────────────────────────── 영상 위 화면 영역(빨강)·베젤(노랑) 표시

export function AnalysisOverlay({ state, videoRef, currentPath }: {
  state: VideoAnalysisState
  videoRef: React.RefObject<HTMLVideoElement | null>
  currentPath: string | null
}) {
  const active = state.open && state.showRoi
  const { boxRef, view } = useVideoView(videoRef, active, currentPath)
  if (!active) return null
  // 직접 지정이면 고른 영역, 아니면 분석에 쓴 영역 (추정한 것)
  const custom = state.roiMode === 'custom'
  const roi = custom ? state.customRoi : state.setup?.roi ?? null
  const bezel = custom ? (state.customRoi ? state.bezel : null) : state.setup?.bezel ?? null
  const place = (b: Box) => view && {
    left: view.left + b[0] * view.vw * view.scale,
    top: view.top + b[1] * view.vh * view.scale,
    width: (b[2] - b[0]) * view.vw * view.scale,
    height: (b[3] - b[1]) * view.vh * view.scale,
  }
  return (
    <div ref={boxRef} className="rv-crop">
      {bezel && <div className="rv-roi-bezel" style={place(bezel) ?? undefined} />}
      {roi && <div className="rv-roi-screen" style={place(roi) ?? undefined} />}
    </div>
  )
}

// ─────────────────────────────── 그래프: 밝기(·베젤 밝기와 대비)·평균 색 띠·검출 음영·스텝 경계 (지금 영상)

interface ChartView { t0: number; t1: number }

function AnalysisChart({ frames, result, bezel, duration, steps, now, onSeek }: {
  frames: VideoFrames | undefined
  result: DetectResult | undefined
  bezel: boolean
  /** 영상 길이 (모르면 받은 프레임 끝까지) */
  duration: number | null
  /** 스텝 시작 (영상 안 초) · 실패 스텝 */
  steps: { t: number; fail: boolean }[]
  /** 지금 재생 위치 (초) */
  now: number
  onSeek: (seconds: number) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<{ x: number; view: ChartView; moved: boolean } | null>(null)
  const [width, setWidth] = useState(0)
  // 보는 범위 (null = 영상 전체)
  const [view, setView] = useState<ChartView | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const n = frames?.n ?? 0
  const measured = n ? frames!.t[n - 1] : 0
  const end = Math.max(duration ?? 0, measured, 1)
  const v = view ?? { t0: 0, t1: end }
  const span = v.t1 - v.t0

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  // 재생하거나 옮겨 가서 지금 위치가 보는 범위 밖으로 나가면 따라간다 (전체 보기면 그대로, 멈춘 채 확대·이동한 것은 그대로)
  const lastNow = useRef(now)
  useEffect(() => {
    const moved = now !== lastNow.current
    lastNow.current = now
    if (!moved || !view || (now >= view.t0 && now <= view.t1)) return
    const id = requestAnimationFrame(() => {
      const t0 = Math.max(0, Math.min(end - (view.t1 - view.t0), now - (view.t1 - view.t0) * 0.1))
      setView({ t0, t1: t0 + (view.t1 - view.t0) })
    })
    return () => cancelAnimationFrame(id)
  }, [now, view, end])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !width) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(CHART_H * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, CHART_H)
    const plotH = CHART_H - STRIP_H - 2
    const xOf = (t: number) => ((t - v.t0) / span) * width
    // 아직 안 잰 부분
    if (!frames?.done && measured < v.t1) {
      ctx.fillStyle = 'rgba(128, 128, 128, 0.12)'
      const x = Math.max(0, xOf(measured))
      ctx.fillRect(x, 0, width - x, CHART_H)
    }
    // 검출 구간 음영
    for (const s of result?.segments ?? []) {
      if (s.end < v.t0 || s.start > v.t1) continue
      ctx.fillStyle = SEG_COLOR[s.kind]
      const x = xOf(s.start)
      ctx.fillRect(x, 0, Math.max(1, xOf(s.end) - x), plotH)
    }
    // 스텝 경계 (실패 스텝은 빨강, 위에 그린다). 촘촘하면(픽셀 4개에 하나 넘게) 통과 스텝은 아래 짧은 눈금만 (밝기 선이 묻히지 않게)
    const shown = steps.filter((s) => s.t >= v.t0 && s.t <= v.t1)
    const dense = shown.length > width / 4
    for (const fail of [false, true]) {
      ctx.fillStyle = fail ? 'rgba(201, 57, 47, 0.85)' : 'rgba(30, 142, 90, 0.45)'
      const y = fail || !dense ? 0 : plotH - 6
      for (const s of shown) if (s.fail === fail) ctx.fillRect(Math.floor(xOf(s.t)), y, 1, plotH - y)
    }
    // 화면 전환 (위쪽 짧은 눈금)
    ctx.fillStyle = TRANSITION_COLOR
    for (const t of result?.transitions ?? []) if (t >= v.t0 && t <= v.t1) ctx.fillRect(Math.floor(xOf(t)), 0, 1, 7)
    if (!frames || !n) return
    // 밝기: 칸(픽셀 열)마다 최소~최대, 프레임이 적으면 프레임마다 선으로. 축은 보이는 범위 최대에 맞춘다
    const i0 = Math.max(0, bisectLeft(frames.t, v.t0, n) - 1)
    const i1 = Math.min(n, bisectLeft(frames.t, v.t1, n) + 1)
    let top = 16
    for (let i = i0; i < i1; i++) {
      if (frames.y[i] > top) top = frames.y[i]
      if (bezel && frames.b[i] > top) top = frames.b[i]
    }
    top = Math.ceil((top * 1.08) / 8) * 8
    const yOf = (value: number) => plotH - (value / top) * (plotH - 4)
    const cols = Math.max(1, width)
    const yLo = new Float32Array(cols).fill(Infinity)
    const yHi = new Float32Array(cols).fill(-Infinity)
    const bLo = new Float32Array(cols).fill(Infinity)
    const bHi = new Float32Array(cols).fill(-Infinity)
    const sum = new Float64Array(cols * 3)
    const count = new Uint32Array(cols)
    for (let i = i0; i < i1; i++) {
      const x = Math.floor(xOf(frames.t[i]))
      if (x < 0 || x >= cols) continue
      const y = frames.y[i]
      if (y < yLo[x]) yLo[x] = y
      if (y > yHi[x]) yHi[x] = y
      const b = frames.b[i]
      if (b < bLo[x]) bLo[x] = b
      if (b > bHi[x]) bHi[x] = b
      sum[x * 3] += frames.rgb[i * 3]
      sum[x * 3 + 1] += frames.rgb[i * 3 + 1]
      sum[x * 3 + 2] += frames.rgb[i * 3 + 2]
      count[x]++
    }
    // 대비 (베젤 밝기 ~ 화면 밝기 사이)
    if (bezel) {
      ctx.fillStyle = 'rgba(47, 111, 222, 0.2)'
      for (let x = 0; x < cols; x++) {
        if (!count[x]) continue
        const a = yOf((yLo[x] + yHi[x]) / 2)
        const b = yOf((bLo[x] + bHi[x]) / 2)
        ctx.fillRect(x, Math.min(a, b), 1, Math.abs(a - b))
      }
    }
    const sparse = i1 - i0 <= width * 2
    const draw = (values: Float32Array, lo: Float32Array, hi: Float32Array, color: string) => {
      ctx.strokeStyle = color
      ctx.fillStyle = color
      if (sparse) {
        ctx.lineWidth = 1.5
        ctx.beginPath()
        for (let i = i0; i < i1; i++) {
          const x = xOf(frames.t[i])
          if (i === i0) ctx.moveTo(x, yOf(values[i]))
          else ctx.lineTo(x, yOf(values[i]))
        }
        ctx.stroke()
        return
      }
      for (let x = 0; x < cols; x++) {
        if (!count[x]) continue
        const a = yOf(hi[x])
        ctx.fillRect(x, a, 1, Math.max(1.5, yOf(lo[x]) - a))
      }
    }
    if (bezel) draw(frames.b, bLo, bHi, BEZEL_COLOR)
    draw(frames.y, yLo, yHi, BRIGHT_COLOR)
    // 화면 평균 색 띠
    for (let x = 0; x < cols; x++) {
      if (!count[x]) continue
      const k = count[x]
      ctx.fillStyle = `rgb(${Math.round(sum[x * 3] / k)}, ${Math.round(sum[x * 3 + 1] / k)}, ${Math.round(sum[x * 3 + 2] / k)})`
      ctx.fillRect(x, CHART_H - STRIP_H, 1, STRIP_H)
    }
    ctx.fillStyle = 'rgba(128, 128, 128, 0.9)'
    ctx.font = '10px sans-serif'
    ctx.fillText(String(top), 2, 10)
  }, [frames, n, measured, result, bezel, steps, width, v.t0, v.t1, span])

  // 휠: 커서 위치 기준 시간축 확대·축소, Shift+휠·가로 휠은 좌우 이동 (페이지가 스크롤되지 않게 passive 아님)
  useEffect(() => {
    const box = boxRef.current
    if (!box || !width) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = box.getBoundingClientRect()
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dt = ((e.shiftKey ? e.deltaY : e.deltaX) / r.width) * span
        const t0 = Math.max(0, Math.min(end - span, v.t0 + dt))
        setView({ t0, t1: t0 + span })
        return
      }
      const at = v.t0 + ((e.clientX - r.left) / r.width) * span
      const next = Math.min(end, Math.max(0.5, span * Math.exp(e.deltaY * 0.0015)))
      if (next >= end) return setView(null)
      const t0 = Math.max(0, Math.min(end - next, at - ((at - v.t0) * next) / span))
      setView({ t0, t1: t0 + next })
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  })

  const timeAt = (clientX: number, r: DOMRect) => v.t0 + ((clientX - r.left) / r.width) * span
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    dragRef.current = { x: e.clientX, view: v, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setHover(timeAt(e.clientX, r))
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.x
    if (Math.abs(dx) > 3) d.moved = true
    if (!d.moved) return
    const s = d.view.t1 - d.view.t0
    if (s >= end) return
    const t0 = Math.max(0, Math.min(end - s, d.view.t0 - (dx / r.width) * s))
    setView({ t0, t1: t0 + s })
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (d && !d.moved) onSeek(Math.max(0, Math.min(end, timeAt(e.clientX, e.currentTarget.getBoundingClientRect()))))
  }

  // 커서 위치의 값 (가장 가까운 프레임)
  const at = hover !== null && frames && n ? Math.min(n - 1, bisectLeft(frames.t, hover, n)) : -1
  return (
    <div className="rv-va-chart">
      <div className="rv-va-legend small">
        <span><i style={{ background: BRIGHT_COLOR }} />화면 밝기</span>
        {bezel && <span><i style={{ background: BEZEL_COLOR }} />기준 밝기(베젤)</span>}
        <span><i className="rv-va-rgb" />화면 평균 색 (아래 띠)</span>
        <span><i style={{ background: SEG_COLOR.black_screen }} />검은 화면</span>
        <span><i style={{ background: SEG_COLOR.flicker }} />깜박임</span>
        <span><i style={{ background: SEG_COLOR.static }} />정지</span>
        <span><i style={{ background: TRANSITION_COLOR }} />화면 전환</span>
        {steps.length > 0 && <span><i style={{ background: '#1e8e5a' }} />스텝 <i style={{ background: '#c9392f' }} />실패 스텝</span>}
        <span className="rv-spacer" />
        <span className="mono muted">
          {at >= 0
            ? `${formatFrameTime(frames!.t[at])} · ${frames!.y[at].toFixed(1)}${bezel ? ` / ${frames!.b[at].toFixed(1)}` : ''}`
            : `${formatFrameTime(v.t0)} ~ ${formatFrameTime(v.t1)}`}
        </span>
      </div>
      <div
        ref={boxRef}
        className="rv-va-plot"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => { dragRef.current = null }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={() => setView(null)}
      >
        <canvas ref={canvasRef} style={{ height: CHART_H }} />
        {now >= v.t0 && now <= v.t1 && <div className="rv-va-now" style={{ left: `${((now - v.t0) / span) * 100}%` }} />}
      </div>
      <div className="small muted">휠 = 시간축 확대·축소 · 드래그 = 좌우 이동 · 클릭 = 그 시점으로 이동 · 더블클릭 = 전체 보기</div>
    </div>
  )
}

// ─────────────────────────────── 검출 내용 글

function SegmentDetail({ seg }: { seg: DetectedSegment }) {
  const info = seg.info
  if (info.type === 'black_screen') {
    const parts: string[] = []
    if (info.contrast) {
      parts.push(`화면−베젤 대비 ${info.contrast.value.toFixed(0)} (꺼짐 기준 ≤${info.contrast.off.toFixed(0)} · 베젤 밝기 ${info.contrast.bezel.toFixed(0)}, 켜진 평소 대비 ${info.contrast.on.toFixed(0)})`)
    }
    if (info.bright) parts.push(`밝기 ${info.bright.value.toFixed(0)}/평소 ${info.bright.ref.toFixed(0)}`)
    if (info.grid) parts.push(`윤곽이 가장 많은 칸 ${info.grid.value.toFixed(1)} (꺼짐 기준 ≤${info.grid.off.toFixed(1)})`)
    if (info.edge) parts.push(`윤곽 ${info.edge.value.toFixed(2)}/평소 ${info.edge.ref.toFixed(2)}`)
    return <>{parts.map((p, i) => <span key={i}>{i > 0 && ', '}<span>{p}</span></span>)}</>
  }
  if (info.type === 'flicker') {
    return (
      <>
        <span>{info.count === 1 ? '순간 깜박임 1회' : `깜박임 ${info.count}회 반복`}</span>{' ('}
        {info.kinds.map((k, i) => <span key={k}>{i > 0 && '·'}<span>{k === 'dark' ? '어두워짐' : '밝게 번쩍임'}</span></span>)}
        {', '}<span>{`최대 ${info.depth}% 변화`}</span>{', '}<span>{`${info.dur.toFixed(2)}초 안에 원래 밝기로 복귀`}</span>{')'}
      </>
    )
  }
  return <span>{`${info.seconds.toFixed(1)}초 동안 화면 변화 없음 (프리징 또는 정상 대기)`}</span>
}

// ─────────────────────────────── 패널: 설정·진행·그래프·검출 목록

/** 목록 한 줄: 영상 index번째의 검출 구간 또는 화면 전환 (number: 전체에서 몇 번째) */
interface Item {
  key: string
  video: number
  path: string
  start: number
  seg: DetectedSegment | null
  number: number
}

export function VideoAnalysisPanel({ state, videos, steps, currentPath, grab, escape, nowSeconds, wallOf, onSeek }: {
  state: VideoAnalysisState
  videos: SearchVideo[]
  /** 검출 시점의 스텝을 찾고 그래프에 스텝 경계를 그리는 Result 표 */
  steps: StepSource
  currentPath: string | null
  /** 영역 고르기 창에 띄울 지금 프레임 (아직 보이는 프레임이 없으면 null) */
  grab: () => FrameShot | null
  /** Esc를 이 패널이 받을지 (자르기·저장 창이 열려 있으면 false) */
  escape: boolean
  /** 지금 영상 위치(초) */
  nowSeconds: number
  /** 영상 위치 → 벽시계 ms (모르면 null) */
  wallOf: (path: string, seconds: number) => number | null
  /** 영상·위치로 이동 (play: 거기서 재생) */
  onSeek: (path: string, seconds: number, play?: boolean) => void
}) {
  const [tab, setTab] = useState<Tab>('overview')
  const [limit, setLimit] = useState(LIST_PAGE)
  const [grabError, setGrabError] = useState<string | null>(null)
  const custom = state.roiMode === 'custom'
  const openPicker = (kind: 'screen' | 'bezel') => {
    const frame = grab()
    setGrabError(frame ? null : '영상 프레임을 아직 읽지 못했습니다. 영상이 보이면 다시 누르세요')
    if (frame) state.setPicking({ kind, frame })
  }

  // Esc: 영역 고르기 창 → 패널 닫기 순 (결과 확인 창이 닫히지 않게 먼저 받는다)
  useEffect(() => {
    if (!escape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (state.picking) state.setPicking(null)
      else state.close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state, escape])

  // 검출 시점의 스텝: 그때 하던 스텝 (영상 시작 시각을 몰라 벽시계를 모르면 없음, 테스트가 끝난 뒤면 없음)
  const timedRows = useMemo(() => steps.rows.filter((r) => r.time !== null).sort((a, b) => a.time! - b.time! || a.index - b.index), [steps.rows])
  const runEnd = useMemo(() => timedRows.reduce((end, r) => Math.max(end, r.time! + (r.durationMs ?? 0)), -Infinity), [timedRows])
  const stepAt = (path: string, seconds: number): { row: ResultRow; offset: number } | null => {
    const wall = wallOf(path, seconds)
    const row = wall === null || wall > runEnd ? null : rowAtTime(timedRows, wall)
    return wall !== null && row?.time != null ? { row, offset: (wall - row.time) / 1000 } : null
  }
  // 그래프의 스텝 경계 (지금 영상)
  const chartSteps = useMemo(() => steps.rows.flatMap((r) => {
    const at = r.time === null ? null : steps.position(r)
    return at && at.path === currentPath ? [{ t: at.seconds, fail: statusTone(r.status) === 'bad' }] : []
  }), [steps, currentPath])

  // 모든 영상의 검출을 종류별로 (영상 차례 → 시작 순)
  const items = useMemo(() => {
    const out: Record<Exclude<Tab, 'overview'>, Item[]> = { black_screen: [], flicker: [], static: [], transitions: [] }
    state.results.forEach((r, video) => {
      const path = state.frames[video]?.path ?? videos[video]?.path ?? ''
      for (const seg of r.segments) {
        const list = out[seg.kind]
        list.push({ key: `${seg.kind}:${path}:${seg.start}`, video, path, start: seg.start, seg, number: list.length + 1 })
      }
      for (const t of r.transitions) {
        out.transitions.push({ key: `t:${path}:${t}`, video, path, start: t, seg: null, number: out.transitions.length + 1 })
      }
    })
    return out
  }, [state.results, state.frames, videos])
  const counts = {
    black_screen: items.black_screen.length, flicker: items.flicker.length, static: items.static.length,
    transitions: state.results.reduce((n, r) => n + r.nTransitions, 0),
  }

  const current = videos.findIndex((v) => v.path === currentPath)
  const curFrames = current >= 0 ? state.frames[current] : undefined
  const curResult = current >= 0 ? state.results[current] : undefined
  const bezelUsed = !!state.setup?.bezel
  const totalFrames = state.frames.reduce((n, f) => n + (f?.n ?? 0), 0)
  const hasResult = state.frames.some((f) => f?.n)
  const nameOf = (path: string) => videos.find((v) => v.path === path)?.name ?? path

  const pick = (item: Item) => {
    state.setPicked(item.key)
    // 그 순간을 보게 조금 앞부터 재생 (전환은 바뀐 직후까지)
    onSeek(item.path, Math.max(0, item.start - (item.seg ? LEAD_S : 0.5)), true)
  }
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    if (!state.picked) return
    listRef.current?.querySelector('li.picked')?.scrollIntoView({ block: 'nearest' })
  }, [state.picked, tab])

  const pickedFrame = state.picking?.frame
  const applyPick = (sel: Rect): string | null => {
    if (!state.picking || !pickedFrame) return null
    const box = rectToBox(sel, pickedFrame.width, pickedFrame.height)
    if (state.picking.kind === 'screen') {
      state.setCustomRoi(box)
      state.setRoiMode('custom')
    } else state.setBezel(box)
    state.setPicking(null)
    return null
  }
  const asRect = (b: Box | null) => (b && pickedFrame ? boxToRect(b, pickedFrame.width, pickedFrame.height) : null)

  const status = state.status
  const pct = Math.round((status?.progress ?? 0) * 100)
  const list = tab === 'overview' ? [] : items[tab]
  const multi = videos.length > 1

  return (
    <div className="rv-search rv-va">
      <div className="rv-search-bar">
        <strong title="화면 영역의 밝기·윤곽·변화량을 프레임마다 재서 검은 화면·깜박임·정지 구간·화면 전환을 찾습니다 (테스트 PC에서 ffmpeg)">영상 분석</strong>
        <span className="rv-search-group">
          <label className="small" title="밝기·윤곽을 잴 화면 부분. 자동 추정 = 칸별 윤곽 변화가 큰 곳 (웹캠으로 찍은 모니터 화면)">
            화면 영역
            <select
              value={state.roiMode}
              onChange={(e) => {
                const mode = e.target.value as RoiMode
                state.setRoiMode(mode)
                if (mode === 'custom' && !state.customRoi) openPicker('screen')
              }}
            >
              <option value="auto">자동 추정</option>
              <option value="full">화면 전체</option>
              <option value="custom">직접 지정</option>
            </select>
          </label>
          {custom && <button type="button" onClick={() => openPicker('screen')} title="지금 프레임을 크게 띄워 화면 부분을 고릅니다">영역 지정</button>}
          {custom && state.customRoi && (
            <button
              type="button"
              onClick={() => openPicker('bezel')}
              title="모니터 테두리 바깥선을 고르면 테두리 띠의 밝기를 기준으로 화면 대비를 봅니다 (웹캠 자동 노출로 전체가 어두워져도 흔들리지 않음)"
            >
              {state.bezel ? '베젤 다시 지정' : '베젤 지정'}
            </button>
          )}
          {custom && state.customRoi && state.bezel && (
            <button type="button" className="small-btn" onClick={() => state.setBezel(null)} title="베젤 없이 화면 밝기로 판정">베젤 지우기</button>
          )}
        </span>
        <label className="small" title="영상 위에 화면 영역(빨강)·베젤(노랑) 표시">
          <input type="checkbox" checked={state.showRoi} onChange={(e) => state.setShowRoi(e.target.checked)} />
          영상에 표시
        </label>
        <label className="small" title="화면 변화가 이 시간 이상 없으면 정지 구간. 바꾸면 다시 재지 않고 바로 다시 나눕니다">
          정지 기준
          <select value={state.staticS} onChange={(e) => state.changeStatic(Number(e.target.value))}>
            {[5, 10, 20, 30, 60].map((s) => <option key={s} value={s}>{s}초</option>)}
          </select>
        </label>
        <span className="rv-search-go">
          {state.running
            ? <button type="button" onClick={state.stop} title="거기까지 잰 결과는 남깁니다">멈춤</button>
            : (
              <button
                type="button"
                className="primary"
                disabled={videos.length === 0 || (custom && !state.customRoi) || state.picking !== null}
                onClick={() => void state.run()}
              >
                {hasResult ? '다시 분석' : '분석'}
              </button>
            )}
          <button type="button" className="icon" aria-label="닫기" title="닫기 (Esc)" onClick={state.close}>✕</button>
        </span>
      </div>
      {state.running && (
        <div className="small muted">
          <progress max={1} value={status?.progress ?? 0} />{' '}
          {`분석 중 ${pct}%`}{status?.current ? ` · ${status.current}` : ''}{' · 앞부분부터 끝난 만큼 먼저 보여 줍니다'}
        </div>
      )}
      {state.running && state.retrying && <p className="small muted">테스트 PC 연결이 잠깐 끊겨 다시 묻는 중… (분석은 테스트 PC에서 계속됩니다)</p>}
      {!state.running && status?.state === 'done' && (
        <div className="small muted">
          {`분석 완료 · 프레임 ${totalFrames.toLocaleString()}장`}{state.elapsed !== null && ` · 걸린 시간 ${formatDuration(state.elapsed * 1000)}`}
        </div>
      )}
      {!state.running && status?.state === 'canceled' && <div className="small rv-search-warn">멈춤 — 거기까지 잰 결과입니다</div>}
      {grabError && <p className="error small">{grabError}</p>}
      {state.error && <p className="error small">{state.error}</p>}
      {state.frames.filter((f) => f?.error).map((f) => <p key={f.path} className="error small">{`${nameOf(f.path)}: ${f.error}`}</p>)}
      {!hasResult && !state.running && !state.error && (
        <p className="small muted">
          {`[분석]을 누르면 이 실행의 영상 ${videos.length}개를 테스트 PC에서 프레임마다 재서 검은 화면·깜박임·정지 구간·화면 전환을 찾습니다.`}
        </p>
      )}
      {hasResult && (
        <>
          <AnalysisChart
            frames={curFrames}
            result={curResult}
            bezel={bezelUsed}
            duration={current >= 0 ? videos[current].duration : null}
            steps={chartSteps}
            now={nowSeconds}
            onSeek={(t) => currentPath && onSeek(currentPath, t)}
          />
          <div className="rv-va-tabs">
            {TABS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`small-btn${tab === k ? ' active' : ''}`}
                onClick={() => {
                  setTab(k)
                  setLimit(LIST_PAGE)
                }}
              >
                {label}
                {k !== 'overview' && <span className={`rv-va-count${counts[k] ? ` on ${k}` : ''}`}>{counts[k]}</span>}
              </button>
            ))}
          </div>
          {tab === 'overview' ? (
            <div className="rv-va-overview small">
              <div className="rv-va-kv">
                <span className="muted">프레임</span>
                <span>
                  {state.frames.map((f, i) => f && (
                    <span key={f.path} className="rv-va-video">
                      {multi && <span translate="no">{`${nameOf(f.path)}: `}</span>}
                      {`${f.n.toLocaleString()}장 · ${state.results[i]?.fps ?? '-'}fps · ${formatFrameTime(f.n ? f.t[f.n - 1] : 0)}`}
                    </span>
                  ))}
                </span>
                <span className="muted">화면 영역</span>
                <span>
                  {state.setup?.roi ? <span className="mono">{boxText(state.setup.roi)}</span> : '-'}
                  {state.setup?.roiSource && <span className="muted">{' · '}<span>{state.setup.roiSource}</span></span>}
                </span>
                <span className="muted">베젤</span>
                <span>{state.setup?.bezel ? <span className="mono">{boxText(state.setup.bezel)}</span> : <span>없음</span>}</span>
                <span className="muted">기준값</span>
                <span>
                  {curResult?.ref
                    ? `${bezelUsed ? '화면−베젤 대비' : '밝기'} ${curResult.ref.bright} · 윤곽이 가장 많은 칸 ${curResult.ref.grid ?? '-'} · 평소 변화 ${curResult.ref.noise}`
                    : '-'}
                  <span className="muted"> (지금 영상, 직전 10분의 상위 25% 값)</span>
                </span>
              </div>
              <ul className="rv-va-rules muted">
                <li>검은 화면: 밝기(베젤이 있으면 화면−베젤 대비)가 꺼진 수준이고, 윤곽이 가장 많은 칸도 비어 있고, 색이 없음 (0.3초 미만·깜박임은 뺌)</li>
                <li>깜박임: 밝기가 평소보다 25%(최소 12) 넘게 벗어났다가 0.6초 안에 돌아옴 (3초 안에 이어지면 한 묶음)</li>
                <li>정지 구간: 화면 영역의 프레임 간 차이가 잡음 수준으로 정지 기준 이상 이어짐 (통째로 꺼진 구간은 뺌)</li>
                <li>화면 전환: 프레임 차이가 평소의 8배(최소 6) 넘게 튄 시점 (0.5초 안에 이어지면 한 건, 깜박임은 뺌)</li>
              </ul>
            </div>
          ) : (
            <ol className={`rv-va-list${tab === 'transitions' ? ' tr' : ''}${multi ? ' multi' : ''}`} ref={listRef}>
              <li className="rv-va-head">
                <span>{tab === 'transitions' ? '#' : '길이'}</span>
                <span>시각</span>
                <span>영상 위치</span>
                <span>스텝</span>
                {tab !== 'transitions' && <span>내용</span>}
              </li>
              {list.length === 0 && <li className="muted small rv-va-empty">{state.running ? '아직 없음 (분석 중)' : '없음'}</li>}
              {list.slice(0, limit).map((item) => {
                const wall = wallOf(item.path, item.start)
                const step = stepAt(item.path, item.start)
                return (
                  <li key={item.key} className={item.key === state.picked ? 'picked' : ''} onClick={() => pick(item)} title="누르면 그 순간 조금 앞부터 재생">
                    <span className="mono small rv-search-num">{item.seg ? `${item.seg.dur.toFixed(2)}s` : item.number}</span>
                    <button type="button" className="link mono">{wall !== null ? formatWall(wall, true) : formatFrameTime(item.start)}</button>
                    <span className="mono small muted ellipsis" title={multi ? nameOf(item.path) : undefined}>
                      {`${formatFrameTime(item.start)}${multi ? ` · ${nameOf(item.path)}` : ''}`}
                    </span>
                    <span className="small ellipsis" title={step ? `#${step.row.index + 1} ${step.row.name}` : undefined}>
                      {step ? <>{`#${step.row.index + 1} ${step.row.name} `}<span className="muted">{`(+${step.offset.toFixed(2)}s)`}</span></> : <span className="muted">-</span>}
                    </span>
                    {item.seg && <span className="small rv-va-detail"><SegmentDetail seg={item.seg} /></span>}
                  </li>
                )
              })}
              {list.length > limit && (
                <li className="rv-va-more">
                  <button type="button" className="small-btn" onClick={() => setLimit(limit + LIST_PAGE)}>{`더 보기 (${list.length - limit}개 남음)`}</button>
                </li>
              )}
              {tab === 'transitions' && counts.transitions > list.length && (
                <li className="muted small rv-va-empty">{`전체 ${counts.transitions}개 중 앞 ${list.length}개만 목록에 있습니다`}</li>
              )}
            </ol>
          )}
        </>
      )}
      {state.picking && pickedFrame && (
        <RectPickerDialog
          frame={pickedFrame}
          title={state.picking.kind === 'screen' ? '화면 영역 지정' : '베젤 외곽 지정'}
          confirmLabel={state.picking.kind === 'screen' ? '이 영역으로 지정' : '베젤로 지정'}
          initial={asRect(state.picking.kind === 'screen' ? state.customRoi : state.bezel)}
          reference={asRect(state.picking.kind === 'screen' ? state.bezel : state.customRoi)}
          variant={state.picking.kind}
          onApply={applyPick}
          onCancel={() => state.setPicking(null)}
        />
      )}
    </div>
  )
}
