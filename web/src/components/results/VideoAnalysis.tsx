import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatDuration } from '../../format'
import { newId } from '../explorer/pcGroups'
import { clamp, cornersOf, formatFrameTime, type Point, type Quad, useVideoView } from './frameUtil'
import type { FrameShot, SearchVideo, StepSource } from './imageSearchState'
import { QuadPickerDialog } from './QuadPicker'
import { useNow } from './resultJobs'
import { formatWall, type ResultRow, statusTone } from './resultCsv'
import { rowAtTime } from './sync'
import type { VideoAnalysisState, VideoFrames } from './videoAnalysisState'
import { CYCLE_COLOR, type CycleAnomaly, type CycleCompare, type CycleMap } from './videoCycle'
import { bisectLeft, type DetectedSegment, type DetectResult, type SegmentKind } from './videoDetect'
import { type Exclusion, type ExclusionDraft, spansOf } from './videoExclude'

// 결과 확인 영상 분석 화면 (ReplayKit_FailAnalyzer 영상 페이지의 영상 분석을 옮김):
// 영상 위 화면 영역 표시(AnalysisOverlay) · 영상 아래 설정·진행·그래프·영상 정보(VideoAnalysisPanel) ·
// 결과 표 아래 검출 탭·목록(VideoAnalysisResults, 탭 줄은 영상 조작 줄과 같은 높이) · 결과 표 위 제외 구간 고르기(ExcludeBar).
// 상태·받기는 videoAnalysisState, 판정은 videoDetect, 제외 구간은 videoExclude

type ListTab = SegmentKind | 'transitions' | 'cycle'
const TABS: [ListTab, string][] = [
  ['black_screen', '검은 화면'], ['flicker', '깜박임'], ['static', '정지 구간'], ['transitions', '화면 전환'], ['cycle', 'Cycle 비교'],
]
// 탭에 대면 보이는 판정 기준
const RULES: Record<ListTab, string> = {
  black_screen: '검은 화면: 밝기가 기준 밝기(영상에서 가장 어두웠던 밝기)에 가깝고(차이가 5 · 기준 밝기의 15% · 켜진 평소 차이의 20% 중 큰 값 이하), 윤곽이 가장 많은 칸도 비어 있고, 색이 없음 (0.3초 미만·깜박임은 뺌)',
  flicker: '깜박임: 밝기가 평소보다 25%(최소 12) 넘게 어두워지고 기준 밝기까지 5% 미만(평소 밝기 − 기준 밝기의 5%)으로 내려갔다가 0.6초 안에 돌아옴 (밝게 번쩍이는 것은 뺌, 3초 안에 이어지면 한 묶음)',
  static: '정지 구간: 화면 영역의 프레임 간 차이가 잡음 수준으로 정지 기준 이상 이어짐 (통째로 꺼진 구간은 뺌)',
  transitions: '화면 전환: 프레임 차이가 평소의 8배(최소 6) 넘게 튄 시점 (0.5초 안에 이어지면 한 건, 깜박임은 뺌)',
  cycle: 'Cycle 비교: 첫 Cycle을 기준으로 이후 Cycle의 같은 스텝(이름과 그 Cycle 안에서 몇 번째인지) 동안 화면 밝기·평균 색을 스텝 시작부터 0.2초마다 견줘, 밝기 차이(평균 색은 1.5배)가 기준을 넘는 것이 0.6초 넘게 이어진 곳 (앞뒤 0.6초 어긋남은 봐 줌, 스텝 시작·끝 0.4초는 뺌)',
}
const SEG_COLOR: Record<SegmentKind, string> = {
  black_screen: 'rgba(201, 57, 47, 0.35)', flicker: 'rgba(183, 121, 31, 0.4)', static: 'rgba(120, 130, 145, 0.22)',
}
const BRIGHT_COLOR = '#2f6fde'
const FLOOR_COLOR = '#8a8f98'
const TRANSITION_COLOR = '#8e44ad'
const STEP_COLOR = '#1e8e5a'
const FAIL_COLOR = '#c9392f'
// 아래 평균 색 띠 높이
const STRIP_H = 10
// 목록은 이만큼씩 그린다 ("더 보기")
const LIST_PAGE = 500
// 검출 항목을 누르면 이만큼 앞부터 재생 (그 순간을 보게)
const LEAD_S = 1.5
// 그래프에 겹칠 Cycle 짝이 없을 때 (매번 새 배열을 만들지 않게)
const NO_MAPS: CycleMap[] = []
// 정지 기준 칸 (초)
const STATIC_MAX = 86400

/** 그래프에 그리는 것: 범례를 눌러 켜고 끈다 (끈 것은 이 브라우저에 기억) */
type Series = 'bright' | 'floor' | 'rgb' | SegmentKind | 'transitions' | 'refBright' | 'cycle' | 'exclude' | 'steps' | 'fail'
const SERIES: [Series, string][] = [
  ['bright', '화면 밝기'], ['floor', '기준 밝기'], ['rgb', '화면 평균 색 (아래 띠)'], ['black_screen', '검은 화면'], ['flicker', '깜박임'],
  ['static', '정지'], ['transitions', '화면 전환'], ['refBright', '첫 Cycle 밝기'], ['cycle', 'Cycle 차이'],
  ['exclude', '제외 구간'], ['steps', '스텝'], ['fail', '실패 스텝'],
]
// 첫 Cycle 밝기 (같은 스텝 자리에 겹쳐 그림) · Cycle 차이 음영
const REF_COLOR = '#e08a1e'
const CYCLE_SHADE = 'rgba(15, 154, 168, 0.3)'
const SWATCH: Partial<Record<Series, string>> = {
  bright: BRIGHT_COLOR, floor: FLOOR_COLOR, ...SEG_COLOR, transitions: TRANSITION_COLOR, refBright: REF_COLOR, cycle: CYCLE_SHADE,
  steps: STEP_COLOR, fail: FAIL_COLOR,
}
const HIDDEN_KEY = 'results.va.hidden'
function readHidden(): Set<Series> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')
    return new Set(Array.isArray(saved) ? (saved as Series[]) : [])
  } catch {
    return new Set()
  }
}

// 제외 구간 빗금 (한 번 만들어 쓴다)
let hatchTile: HTMLCanvasElement | null = null
function hatchPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (!hatchTile) {
    hatchTile = document.createElement('canvas')
    hatchTile.width = 8
    hatchTile.height = 8
    const tile = hatchTile.getContext('2d')
    if (tile) {
      tile.strokeStyle = 'rgba(128, 128, 128, 0.5)'
      tile.lineWidth = 2
      tile.beginPath()
      tile.moveTo(-2, 10)
      tile.lineTo(10, -2)
      tile.stroke()
    }
  }
  return ctx.createPattern(hatchTile, 'repeat')
}

/** 영역 글 (%): 직사각형은 왼쪽 위 ~ 오른쪽 아래, 꼭짓점 넷은 왼쪽 위부터 시계 방향 */
const regionText = (r: number[]) => {
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`
  return r.length === 8
    ? `꼭짓점 ${cornersOf(r).map(([x, y]) => `${pct(x)},${pct(y)}`).join(' · ')}`
    : `${pct(r[0])}, ${pct(r[1])} ~ ${pct(r[2])}, ${pct(r[3])}`
}

// ─────────────────────────────── 영상 위 화면 영역(빨강) 표시

export function AnalysisOverlay({ state, videoRef, currentPath }: {
  state: VideoAnalysisState
  videoRef: React.RefObject<HTMLVideoElement | null>
  currentPath: string | null
}) {
  const active = state.open && state.showRoi
  const { boxRef, view } = useVideoView(videoRef, active, currentPath)
  if (!active) return null
  // 고른 영역 (없으면 분석에 쓴 영역)
  const roi = state.customRoi ?? state.setup?.roi ?? null
  // 비율 꼭짓점 → 오버레이 안 위치 (비스듬한 영역도 그대로 다각형으로)
  const points = (r: number[]) => (view
    ? cornersOf(r).map(([x, y]) => `${view.left + x * view.vw * view.scale},${view.top + y * view.vh * view.scale}`).join(' ')
    : '')
  return (
    <div ref={boxRef} className="rv-crop">
      {view && roi && (
        <svg className="rv-roi-svg">
          <polygon className="rv-roi-screen" points={points(roi)} />
        </svg>
      )}
    </div>
  )
}

// ─────────────────────────────── 그래프: 밝기·기준 밝기·평균 색 띠·검출 음영·제외 구간·스텝 경계 (지금 영상)

interface ChartView { t0: number; t1: number }

function AnalysisChart({ frames, allFrames, result, excluded, cycleMaps, anomalies, duration, steps, now, onSeek }: {
  frames: VideoFrames | undefined
  /** 모든 영상의 프레임 (첫 Cycle 밝기를 겹쳐 그릴 때) */
  allFrames: VideoFrames[]
  /** 제외 구간을 뺀 검출 */
  result: DetectResult | undefined
  /** 제외 구간 (영상 안 초) */
  excluded: [number, number][]
  /** Cycle 비교: 이 영상 구간 ↔ 첫 Cycle 같은 스텝 · 이 영상의 특이점 */
  cycleMaps: CycleMap[]
  anomalies: CycleAnomaly[]
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
  // 그리는 칸 크기 (패널 아래까지 채운다)
  const [size, setSize] = useState({ w: 0, h: 0 })
  // 보는 범위 (null = 영상 전체)
  const [view, setView] = useState<ChartView | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [hidden, setHidden] = useState(readHidden)
  const n = frames?.n ?? 0
  const measured = n ? frames!.t[n - 1] : 0
  const end = Math.max(duration ?? 0, measured, 1)
  const v = view ?? { t0: 0, t1: end }
  const span = v.t1 - v.t0
  const floor = frames?.floor ?? null
  const { w: width, h: height } = size

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const observer = new ResizeObserver(([entry]) => setSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) }))
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  const toggle = (k: Series) => {
    const next = new Set(hidden)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setHidden(next)
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]))
    } catch {
      // 저장이 막힌 브라우저면 기억만 못 한다
    }
  }

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
    if (!canvas || !width || !height) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const on = (k: Series) => !hidden.has(k)
    const strip = on('rgb') ? STRIP_H : 0
    const plotH = height - (strip ? strip + 2 : 0)
    const xOf = (t: number) => ((t - v.t0) / span) * width
    // 아직 안 잰 부분
    if (!frames?.done && measured < v.t1) {
      ctx.fillStyle = 'rgba(128, 128, 128, 0.12)'
      const x = Math.max(0, xOf(measured))
      ctx.fillRect(x, 0, width - x, height)
    }
    // 제외 구간 (빗금)
    const pattern = on('exclude') && excluded.length ? hatchPattern(ctx) : null
    if (pattern) {
      ctx.fillStyle = pattern
      for (const [a, b] of excluded) {
        if (b < v.t0 || a > v.t1) continue
        const x = xOf(a)
        // 끝이 없는 구간(Infinity)은 보이는 끝까지 (fillRect는 무한 값이면 그리지 않는다)
        ctx.fillRect(x, 0, Math.max(1, xOf(Math.min(b, v.t1)) - x), plotH)
      }
    }
    // 검출 구간 음영
    for (const s of result?.segments ?? []) {
      if (!on(s.kind) || s.end < v.t0 || s.start > v.t1) continue
      ctx.fillStyle = SEG_COLOR[s.kind]
      const x = xOf(s.start)
      ctx.fillRect(x, 0, Math.max(1, xOf(s.end) - x), plotH)
    }
    // Cycle 차이 음영
    if (on('cycle')) {
      ctx.fillStyle = CYCLE_SHADE
      for (const a of anomalies) {
        if (a.end < v.t0 || a.start > v.t1) continue
        const x = xOf(a.start)
        ctx.fillRect(x, 0, Math.max(1, xOf(a.end) - x), plotH)
      }
    }
    // 스텝 경계 (실패 스텝은 빨강, 위에 그린다). 촘촘하면(픽셀 4개에 하나 넘게) 통과 스텝은 아래 짧은 눈금만 (밝기 선이 묻히지 않게)
    const shown = steps.filter((s) => s.t >= v.t0 && s.t <= v.t1)
    const dense = shown.length > width / 4
    for (const fail of [false, true]) {
      if (!on(fail ? 'fail' : 'steps')) continue
      ctx.fillStyle = fail ? 'rgba(201, 57, 47, 0.85)' : 'rgba(30, 142, 90, 0.45)'
      const y = fail || !dense ? 0 : plotH - 6
      for (const s of shown) if (s.fail === fail) ctx.fillRect(Math.floor(xOf(s.t)), y, 1, plotH - y)
    }
    // 화면 전환 (위쪽 짧은 눈금)
    if (on('transitions')) {
      ctx.fillStyle = TRANSITION_COLOR
      for (const t of result?.transitions ?? []) if (t >= v.t0 && t <= v.t1) ctx.fillRect(Math.floor(xOf(t)), 0, 1, 7)
    }
    if (!frames || !n) return
    // 밝기: 칸(픽셀 열)마다 최소~최대, 프레임이 적으면 프레임마다 선으로. 축은 보이는 범위 최대에 맞춘다
    const i0 = Math.max(0, bisectLeft(frames.t, v.t0, n) - 1)
    const i1 = Math.min(n, bisectLeft(frames.t, v.t1, n) + 1)
    let top = 16
    for (let i = i0; i < i1; i++) if (frames.y[i] > top) top = frames.y[i]
    // 첫 Cycle 밝기: 스텝 짝마다 같은 스텝 자리로 옮겨 칸(픽셀 열)마다 평균한 점들 (짝 안에서는 이어 그린다)
    const cols = Math.max(1, width)
    const refLines: [number, number][][] = []
    if (on('refBright')) {
      for (const m of cycleMaps) {
        if (m.end < v.t0 || m.start > v.t1) continue
        const rf = allFrames[m.refVideo]
        if (!rf?.n) continue
        const len = m.end - m.start
        const line: [number, number][] = []
        let col = -1
        let acc = 0
        let k = 0
        const flush = () => {
          if (k) line.push([col + 0.5, acc / k])
        }
        for (let i = bisectLeft(rf.t, m.refStart, rf.n); i < rf.n && rf.t[i] <= m.refStart + len; i++) {
          const x = Math.floor(xOf(m.start + rf.t[i] - m.refStart))
          if (x < -1 || x > cols) continue
          if (x !== col) {
            flush()
            col = x
            acc = 0
            k = 0
          }
          acc += rf.y[i]
          k++
          if (rf.y[i] > top) top = rf.y[i]
        }
        flush()
        if (line.length) refLines.push(line)
      }
    }
    top = Math.ceil((top * 1.08) / 8) * 8
    const yOf = (value: number) => plotH - (value / top) * (plotH - 4)
    const lo = new Float32Array(cols).fill(Infinity)
    const hi = new Float32Array(cols).fill(-Infinity)
    const sum = new Float64Array(cols * 3)
    const count = new Uint32Array(cols)
    for (let i = i0; i < i1; i++) {
      const x = Math.floor(xOf(frames.t[i]))
      if (x < 0 || x >= cols) continue
      const y = frames.y[i]
      if (y < lo[x]) lo[x] = y
      if (y > hi[x]) hi[x] = y
      sum[x * 3] += frames.rgb[i * 3]
      sum[x * 3 + 1] += frames.rgb[i * 3 + 1]
      sum[x * 3 + 2] += frames.rgb[i * 3 + 2]
      count[x]++
    }
    // 기준 밝기 선과 그 위 차이 (기준 밝기 ~ 화면 밝기 사이를 옅게)
    if (on('floor') && floor !== null) {
      const fy = yOf(floor)
      ctx.fillStyle = 'rgba(47, 111, 222, 0.14)'
      for (let x = 0; x < cols; x++) {
        if (!count[x]) continue
        const a = yOf((lo[x] + hi[x]) / 2)
        ctx.fillRect(x, Math.min(a, fy), 1, Math.abs(a - fy))
      }
      ctx.fillStyle = FLOOR_COLOR
      ctx.fillRect(0, fy - 0.75, width, 1.5)
    }
    if (refLines.length) {
      ctx.strokeStyle = REF_COLOR
      ctx.lineWidth = 1.2
      ctx.beginPath()
      for (const line of refLines) {
        line.forEach(([x, value], i) => (i ? ctx.lineTo(x, yOf(value)) : ctx.moveTo(x, yOf(value))))
      }
      ctx.stroke()
    }
    if (on('bright')) {
      ctx.strokeStyle = BRIGHT_COLOR
      ctx.fillStyle = BRIGHT_COLOR
      if (i1 - i0 <= width * 2) {
        ctx.lineWidth = 1.5
        ctx.beginPath()
        for (let i = i0; i < i1; i++) {
          const x = xOf(frames.t[i])
          if (i === i0) ctx.moveTo(x, yOf(frames.y[i]))
          else ctx.lineTo(x, yOf(frames.y[i]))
        }
        ctx.stroke()
      } else {
        for (let x = 0; x < cols; x++) {
          if (!count[x]) continue
          const a = yOf(hi[x])
          ctx.fillRect(x, a, 1, Math.max(1.5, yOf(lo[x]) - a))
        }
      }
    }
    // 화면 평균 색 띠
    if (strip) {
      for (let x = 0; x < cols; x++) {
        if (!count[x]) continue
        const k = count[x]
        ctx.fillStyle = `rgb(${Math.round(sum[x * 3] / k)}, ${Math.round(sum[x * 3 + 1] / k)}, ${Math.round(sum[x * 3 + 2] / k)})`
        ctx.fillRect(x, height - strip, 1, strip)
      }
    }
    ctx.fillStyle = 'rgba(128, 128, 128, 0.9)'
    ctx.font = '10px sans-serif'
    ctx.fillText(String(top), 2, 10)
  }, [frames, allFrames, n, measured, result, excluded, cycleMaps, anomalies, floor, hidden, steps, width, height, v.t0, v.t1, span])

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

  // 커서 위치의 값 (가장 가까운 프레임): 밝기 (기준 밝기와의 차이)
  const at = hover !== null && frames && n ? Math.min(n - 1, bisectLeft(frames.t, hover, n)) : -1
  // 스텝이 없으면 스텝 범례, 지금 영상에 제외 구간이 없으면 제외 구간 범례는 감춘다
  const series = SERIES.filter(([k]) => ((k !== 'steps' && k !== 'fail') || steps.length > 0) && (k !== 'exclude' || excluded.length > 0)
    && ((k !== 'refBright' && k !== 'cycle') || cycleMaps.length > 0))
  return (
    <div className="rv-va-chart">
      <div className="rv-va-legend small">
        {series.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`rv-va-key${hidden.has(k) ? ' off' : ''}`}
            aria-pressed={!hidden.has(k)}
            onClick={() => toggle(k)}
            title="눌러서 그래프에 보이기·감추기"
          >
            <i className={k === 'rgb' ? 'rv-va-rgb' : k === 'exclude' ? 'rv-va-hatch' : undefined} style={SWATCH[k] ? { background: SWATCH[k] } : undefined} />
            {label}
          </button>
        ))}
        <span className="rv-spacer" />
        <span className="mono muted" title="휠 = 시간축 확대·축소 · 드래그 = 좌우 이동 · 클릭 = 그 시점으로 이동 · 더블클릭 = 전체 보기">
          {at >= 0
            ? `${formatFrameTime(frames!.t[at])} · ${frames!.y[at].toFixed(1)}${floor !== null ? ` (+${frames!.c[at].toFixed(1)})` : ''}`
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
        <canvas ref={canvasRef} />
        {now >= v.t0 && now <= v.t1 && <div className="rv-va-now" style={{ left: `${((now - v.t0) / span) * 100}%` }} />}
      </div>
    </div>
  )
}

// ─────────────────────────────── 검출 내용 글

function SegmentDetail({ seg }: { seg: DetectedSegment }) {
  const info = seg.info
  if (info.type === 'black_screen') {
    const parts: string[] = []
    if (info.contrast) {
      parts.push(`기준 밝기와 차이 ${info.contrast.value.toFixed(0)} (꺼짐 기준 ≤${info.contrast.off.toFixed(0)} · 기준 밝기 ${info.contrast.floor.toFixed(0)}, 켜진 평소 차이 ${info.contrast.on.toFixed(0)})`)
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
        <span>{`최대 ${info.depth}% 어두워짐`}</span>{', '}<span>{`${info.dur.toFixed(2)}초 안에 원래 밝기로 복귀`}</span>{')'}
      </>
    )
  }
  return <span>{`${info.seconds.toFixed(1)}초 동안 화면 변화 없음 (프리징 또는 정상 대기)`}</span>
}

/** 숫자 칸 (정지 기준·Cycle 차이 기준): 다 쓰고 Enter를 누르거나 칸을 벗어나면 적용 (치는 중에는 다시 판정하지 않게), 0.1 단위 */
function NumberField({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value))
  const commit = () => {
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n)) return setText(String(value))
    const next = Math.round(clamp(n, min, max) * 10) / 10
    setText(String(next))
    if (next !== value) onCommit(next)
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={1}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

// ─────────────────────────────── 패널 (영상 아래): 설정·진행·그래프·영상 정보

export function VideoAnalysisPanel({ state, staticMin, results, excluded, cycle, videos, steps, currentPath, grab, escape, nowSeconds, onSeek }: {
  state: VideoAnalysisState
  /** 정지 기준의 가장 작은 값 (초): 제외 구간 밖 스텝의 가장 짧은 DURATION */
  staticMin: number
  /** 영상마다 제외 구간을 뺀 검출 */
  results: DetectResult[]
  /** 영상마다 제외 구간 (영상 안 초) */
  excluded: [number, number][][]
  /** 첫 Cycle 기준 비교 (Cycle이 하나면 null) */
  cycle: CycleCompare | null
  videos: SearchVideo[]
  /** 그래프에 스텝 경계를 그리는 Result 표 */
  steps: StepSource
  currentPath: string | null
  /** 영역 고르기 창에 띄울 지금 프레임 (아직 보이는 프레임이 없으면 null) */
  grab: () => FrameShot | null
  /** Esc를 이 패널이 받을지 (자르기·저장 창이 열려 있으면 false) */
  escape: boolean
  /** 지금 영상 위치(초) */
  nowSeconds: number
  /** 영상·위치로 이동 */
  onSeek: (path: string, seconds: number) => void
}) {
  const [grabError, setGrabError] = useState<string | null>(null)
  const openPicker = () => {
    const frame = grab()
    setGrabError(frame ? null : '영상 프레임을 아직 읽지 못했습니다. 영상이 보이면 다시 누르세요')
    if (frame) state.setPicking(frame)
  }

  // Esc: 영역 고르기 창 → 제외 구간 고르기 → 패널 닫기 순 (결과 확인 창이 닫히지 않게 먼저 받는다)
  useEffect(() => {
    if (!escape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (state.picking) state.setPicking(null)
      else if (state.excludeEdit) state.setExcludeEdit(false)
      else state.close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state, escape])

  // 그래프의 스텝 경계 (지금 영상)
  const chartSteps = useMemo(() => steps.rows.flatMap((r) => {
    const at = r.time === null ? null : steps.position(r)
    return at && at.path === currentPath ? [{ t: at.seconds, fail: statusTone(r.status) === 'bad' }] : []
  }), [steps, currentPath])

  const current = videos.findIndex((v) => v.path === currentPath)
  const curFrames = current >= 0 ? state.frames[current] : undefined
  const curResult = current >= 0 ? results[current] : undefined
  const hasResult = state.frames.some((f) => f?.n)
  const multi = videos.length > 1
  const nameOf = (path: string) => videos.find((v) => v.path === path)?.name ?? path
  const curAnomalies = useMemo(() => (cycle?.anomalies ?? []).filter((a) => a.video === current), [cycle, current])

  const frame = state.picking
  /** 고른 꼭짓점 (프레임 픽셀) → 비율 꼭짓점 넷 */
  const applyPick = (corners: Point[]): string | null => {
    if (!frame) return null
    const quad = corners.flatMap(([x, y]) => [Math.round((x / frame.width) * 10000) / 10000, Math.round((y / frame.height) * 10000) / 10000]) as Quad
    state.setCustomRoi(quad)
    state.setPicking(null)
    return null
  }

  const status = state.status
  const pct = Math.round((status?.progress ?? 0) * 100)
  // 분석 중 경과 시간 (1초마다)
  const now = useNow(state.running)
  const ref = curResult?.ref

  return (
    <div className="rv-search rv-va">
      <div className="rv-search-bar">
        <strong title="화면 영역의 밝기·윤곽·변화량을 프레임마다 재서 검은 화면·깜박임·정지 구간·화면 전환을 찾습니다 (테스트 PC에서 ffmpeg)">영상 분석</strong>
        <button
          type="button"
          className={state.customRoi ? '' : 'primary'}
          onClick={openPicker}
          title="밝기·윤곽을 잴 화면 부분: 지금 프레임을 크게 띄워 꼭짓점을 고릅니다 (분석 전에 지정)"
        >
          화면 영역
        </button>
        <label className="small" title="영상 위에 화면 영역(빨강) 표시">
          <input type="checkbox" checked={state.showRoi} onChange={(e) => state.setShowRoi(e.target.checked)} />
          영상에 표시
        </label>
        <label
          className="small"
          title={`화면 변화가 이 시간 이상 없으면 정지 구간 (Enter 또는 칸을 벗어나면 적용 — 다시 재지 않고 바로 다시 나눕니다). 가장 작은 값 = 제외 구간 밖 스텝의 가장 짧은 DURATION (${staticMin}초)`}
        >
          정지 기준
          <NumberField key={state.staticS} value={state.staticS} min={staticMin} max={STATIC_MAX} onCommit={state.changeStatic} />
          초
        </label>
        <button
          type="button"
          className={state.excludeEdit ? 'active' : ''}
          onClick={() => state.setExcludeEdit(!state.excludeEdit)}
          title="Result 표에서 시작·끝 스텝을 골라 그 사이(종료 명령으로 일부러 끈 화면 등)를 검출에서 뺍니다"
        >
          ⛔ 제외 구간
          {state.excludes.length > 0 && <span className="rv-va-count on">{state.excludes.length}</span>}
        </button>
        <span className="rv-search-go">
          {state.running
            ? <button type="button" onClick={state.stop} title="거기까지 잰 결과는 남깁니다">멈춤</button>
            : (
              <button
                type="button"
                className="primary"
                disabled={videos.length === 0 || !state.customRoi || state.picking !== null}
                title={state.customRoi ? undefined : '[화면 영역]을 먼저 지정하세요'}
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
          {`분석 중 ${pct}%`}
          {state.startedAt !== null && ` · 경과 ${formatDuration(now - state.startedAt)}`}
          {status?.current ? ` · ${status.current}` : ''}{' · 앞부분부터 끝난 만큼 먼저 보여 줍니다'}
        </div>
      )}
      {state.running && state.retrying && <p className="small muted">테스트 PC 연결이 잠깐 끊겨 다시 묻는 중… (분석은 테스트 PC에서 계속됩니다)</p>}
      {grabError && <p className="error small">{grabError}</p>}
      {state.error && <p className="error small">{state.error}</p>}
      {state.warning && <p className="small rv-search-warn">{state.warning}</p>}
      {state.frames.filter((f) => f?.error).map((f) => <p key={f.path} className="error small">{`${nameOf(f.path)}: ${f.error}`}</p>)}
      {!hasResult && !state.running && !state.error && (
        <p className="small muted">
          {state.customRoi
            ? `[분석]을 누르면 이 실행의 영상 ${videos.length}개를 테스트 PC에서 프레임마다 재서 검은 화면·깜박임·정지 구간·화면 전환을 찾습니다.`
            : '[화면 영역]을 눌러 잴 화면 부분을 먼저 지정하세요. 그다음 [분석]을 누릅니다.'}
        </p>
      )}
      {hasResult && (
        <AnalysisChart
          frames={curFrames}
          allFrames={state.frames}
          result={curResult}
          excluded={current >= 0 ? excluded[current] ?? [] : []}
          cycleMaps={(current >= 0 && cycle?.maps[current]) || NO_MAPS}
          anomalies={curAnomalies}
          duration={current >= 0 ? videos[current].duration : null}
          steps={chartSteps}
          now={nowSeconds}
          onSeek={(t) => currentPath && onSeek(currentPath, t)}
        />
      )}
      {/* 영상 정보 (지금 영상, 한 줄) */}
      {curFrames && (
        <div className="rv-va-info small">
          {multi && <span translate="no">{nameOf(curFrames.path)}</span>}
          <span>
            <span className="muted">영상 </span>
            {`${curFrames.n.toLocaleString()}장 · ${curResult?.fps ?? '-'}fps · ${formatFrameTime(curFrames.n ? curFrames.t[curFrames.n - 1] : 0)}`}
          </span>
          {state.setup && (
            <span title={state.setup.roi ? regionText(state.setup.roi) : undefined}>
              <span className="muted">화면 영역 </span>
              <span>{state.setup.roiSource ?? '-'}</span>
            </span>
          )}
          {curFrames.floor !== null && (
            <span title="그 영상에서 0.3초 넘게 이어진 가장 낮은 밝기 (꺼진 화면의 밝기). 분석 중에 더 어두운 곳이 나오면 낮추고 처음부터 다시 판정합니다">
              <span className="muted">기준 밝기 </span>
              {curFrames.floor.toFixed(1)}
            </span>
          )}
          {ref && (
            <span title="직전 10분의 상위 25% 값 (기준 밝기와의 차이 · 윤곽이 가장 많은 칸) · 프레임 차이 중앙값">
              {`켜진 평소 차이 ${ref.bright} · 칸 윤곽 ${ref.grid ?? '-'} · 평소 변화 ${ref.noise}`}
            </span>
          )}
          {!state.running && status?.state === 'done' && (
            <span>{state.elapsed !== null ? `분석 완료 (${formatDuration(state.elapsed * 1000)})` : '분석 완료'}</span>
          )}
          {!state.running && status?.state === 'canceled' && <span className="rv-search-warn">{`멈춤 — 거기까지 잰 결과입니다${state.elapsed !== null ? ` (${formatDuration(state.elapsed * 1000)})` : ''}`}</span>}
        </div>
      )}
      {frame && (
        <QuadPickerDialog
          frame={frame}
          title="화면 영역 지정"
          confirmLabel="이 영역으로 지정"
          initial={state.customRoi ? cornersOf(state.customRoi).map(([x, y]) => [Math.round(x * frame.width), Math.round(y * frame.height)]) : null}
          onApply={applyPick}
          onCancel={() => state.setPicking(null)}
        />
      )}
    </div>
  )
}

// ─────────────────────────────── 검출 목록 (결과 표 아래): 종류별 탭 · 목록

/** 목록 한 줄: 영상 index번째의 검출 구간 또는 화면 전환 (number: 전체에서 몇 번째) */
interface Item {
  key: string
  video: number
  path: string
  start: number
  seg: DetectedSegment | null
  number: number
}

export function VideoAnalysisResults({ state, results, removed, cycle, videos, steps, wallOf, onSeek }: {
  state: VideoAnalysisState
  /** 영상마다 제외 구간을 뺀 검출 */
  results: DetectResult[]
  /** 제외 구간으로 뺀 검출 수 */
  removed: number
  /** 첫 Cycle 기준 비교 (Cycle이 하나면 null) */
  cycle: CycleCompare | null
  videos: SearchVideo[]
  /** 검출 시점의 스텝을 찾는 Result 표 */
  steps: StepSource
  /** 영상 위치 → 벽시계 ms (모르면 null) */
  wallOf: (path: string, seconds: number) => number | null
  /** 영상·위치로 이동 (play: 거기서 재생) */
  onSeek: (path: string, seconds: number, play?: boolean) => void
}) {
  const [tabSel, setTab] = useState<ListTab>('black_screen')
  // Cycle 비교 탭은 Cycle이 둘 이상일 때만
  const tab: ListTab = tabSel === 'cycle' && !cycle ? 'black_screen' : tabSel
  const [limit, setLimit] = useState(LIST_PAGE)

  // 검출 시점의 스텝: 그때 하던 스텝 (영상 시작 시각을 몰라 벽시계를 모르면 없음, 테스트가 끝난 뒤면 없음)
  const timedRows = useMemo(() => steps.rows.filter((r) => r.time !== null).sort((a, b) => a.time! - b.time! || a.index - b.index), [steps.rows])
  const runEnd = useMemo(() => timedRows.reduce((end, r) => Math.max(end, r.time! + (r.durationMs ?? 0)), -Infinity), [timedRows])
  const stepAt = (path: string, seconds: number): { row: ResultRow; offset: number } | null => {
    const wall = wallOf(path, seconds)
    const row = wall === null || wall > runEnd ? null : rowAtTime(timedRows, wall)
    return wall !== null && row?.time != null ? { row, offset: (wall - row.time) / 1000 } : null
  }

  // 모든 영상의 검출을 종류별로 (영상 차례 → 시작 순)
  const items = useMemo(() => {
    const out: Record<ListTab, Item[]> = { black_screen: [], flicker: [], static: [], transitions: [], cycle: [] }
    results.forEach((r, video) => {
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
  }, [results, state.frames, videos])
  const counts: Record<ListTab, number> = {
    black_screen: items.black_screen.length, flicker: items.flicker.length, static: items.static.length,
    transitions: results.reduce((n, r) => n + r.nTransitions, 0),
    cycle: cycle?.anomalies.length ?? 0,
  }
  const hasResult = state.frames.some((f) => f?.n)
  const multi = videos.length > 1
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

  const list = items[tab]
  return (
    <div className="rv-va-results">
      <div className="rv-va-tabs">
        {TABS.filter(([k]) => k !== 'cycle' || cycle).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`small-btn${tab === k ? ' active' : ''}`}
            title={RULES[k]}
            onClick={() => {
              setTab(k)
              setLimit(LIST_PAGE)
            }}
          >
            {label}
            <span className={`rv-va-count${counts[k] ? ` on ${k}` : ''}`}>{counts[k]}</span>
          </button>
        ))}
        <span className="rv-spacer" />
        {tab === 'cycle' && cycle && (
          <label className="small rv-va-cycle-diff" title="첫 Cycle과 화면 밝기가 이만큼(0~255) 넘게 다르면 특이점 (평균 색은 1.5배). Enter 또는 칸을 벗어나면 적용">
            {`첫 Cycle(${cycle.ref}) 대비 밝기 차이`}
            <NumberField key={state.cycleDiff} value={state.cycleDiff} min={5} max={200} onCommit={state.setCycleDiff} />
            {`이상 · 스텝 ${cycle.compared}개 비교`}
          </label>
        )}
        {removed > 0 && tab !== 'cycle' && (
          <span className="small muted" title="제외 구간에 걸친 검출은 목록·그래프에서 뺍니다 (검은 화면·정지 구간은 구간 밖으로 남는 부분만 남김)">
            {`제외 구간으로 뺀 검출 ${removed}개`}
          </span>
        )}
      </div>
      {tab === 'cycle' && cycle ? (
        <ol className={`rv-va-list${multi ? ' multi' : ''}`} ref={listRef}>
          <li className="rv-va-head">
            <span>길이</span>
            <span>시각</span>
            <span>영상 위치</span>
            <span>스텝</span>
            <span>내용</span>
          </li>
          {cycle.anomalies.length === 0 && (
            <li className="muted small rv-va-empty">{state.running ? '아직 없음 (분석 중)' : `첫 Cycle(${cycle.ref})과 다른 곳 없음`}</li>
          )}
          {cycle.anomalies.slice(0, limit).map((a) => (
            <CycleItem
              key={a.key}
              a={a}
              picked={a.key === state.picked}
              path={state.frames[a.video]?.path ?? videos[a.video]?.path ?? ''}
              refPath={state.frames[a.refVideo]?.path ?? videos[a.refVideo]?.path ?? ''}
              nameOf={multi ? nameOf : null}
              wallOf={wallOf}
              onPick={(path, seconds) => {
                state.setPicked(a.key)
                onSeek(path, Math.max(0, seconds - LEAD_S), true)
              }}
            />
          ))}
          {cycle.anomalies.length > limit && (
            <li className="rv-va-more">
              <button type="button" className="small-btn" onClick={() => setLimit(limit + LIST_PAGE)}>{`더 보기 (${cycle.anomalies.length - limit}개 남음)`}</button>
            </li>
          )}
        </ol>
      ) : (
      <ol className={`rv-va-list${tab === 'transitions' ? ' tr' : ''}${multi ? ' multi' : ''}`} ref={listRef}>
        <li className="rv-va-head">
          <span>{tab === 'transitions' ? '#' : '길이'}</span>
          <span>시각</span>
          <span>영상 위치</span>
          <span>스텝</span>
          {tab !== 'transitions' && <span>내용</span>}
        </li>
        {list.length === 0 && (
          <li className="muted small rv-va-empty">
            {state.running ? '아직 없음 (분석 중)' : hasResult ? '없음' : '[분석]을 누르면 여기에 검출 목록이 나옵니다'}
          </li>
        )}
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
    </div>
  )
}

/** Cycle 비교 목록 한 줄: 누르면 그 순간, [첫 Cycle]은 기준 Cycle의 같은 자리 */
function CycleItem({ a, picked, path, refPath, nameOf, wallOf, onPick }: {
  a: CycleAnomaly
  picked: boolean
  path: string
  refPath: string
  /** 영상이 여럿이면 영상 이름 */
  nameOf: ((path: string) => string) | null
  wallOf: (path: string, seconds: number) => number | null
  onPick: (path: string, seconds: number) => void
}) {
  const wall = wallOf(path, a.start)
  const delta = a.bright - a.refBright
  return (
    <li className={picked ? 'picked' : ''} onClick={() => onPick(path, a.start)} title="누르면 그 순간 조금 앞부터 재생">
      <span className="mono small rv-search-num">{`${(a.end - a.start).toFixed(1)}s`}</span>
      <button type="button" className="link mono">{wall !== null ? formatWall(wall, true) : formatFrameTime(a.start)}</button>
      <span className="mono small muted ellipsis" title={nameOf ? nameOf(path) : undefined}>
        {`${formatFrameTime(a.start)}${nameOf ? ` · ${nameOf(path)}` : ''}`}
      </span>
      <span className="small ellipsis" title={`#${a.row.index + 1} ${a.row.name}`}>
        {`#${a.row.index + 1} ${a.row.name} `}<span className="muted">{`(+${a.offset.toFixed(1)}s)`}</span>
      </span>
      <span className="small rv-va-detail">
        <span className="rv-va-cycle-tag" style={{ color: CYCLE_COLOR }}>{`Cycle ${a.cycle}`}</span>
        {` 밝기 ${a.refBright.toFixed(0)} → ${a.bright.toFixed(0)} (${delta >= 0 ? '+' : ''}${delta.toFixed(0)}) · 색 차이 ${a.colorDiff} `}
        <button
          type="button"
          className="link small"
          title={`첫 Cycle의 같은 자리 (#${a.refRow.index + 1} ${a.refRow.name} +${a.offset.toFixed(1)}s)`}
          onClick={(e) => {
            e.stopPropagation()
            onPick(refPath, a.refAt)
          }}
        >
          첫 Cycle 보기
        </button>
      </span>
    </li>
  )
}

// ─────────────────────────────── 제외 구간 고르기 (결과 표 위, 자르기처럼 표에서 시작·끝 스텝)

export function ExcludeBar({ state, rows, selected, draft, setDraft }: {
  state: VideoAnalysisState
  /** 시각이 있는 Result 행 (시각순) */
  rows: ResultRow[]
  /** 표에서 고른 행 */
  selected: ResultRow | null
  draft: ExclusionDraft
  setDraft: (draft: ExclusionDraft) => void
}) {
  const order = useMemo(() => new Map(rows.map((r, i) => [r.index, i])), [rows])
  const rowOf = (index: number | null) => (index === null ? null : rows[order.get(index) ?? -1] ?? null)
  const cycles = useMemo(() => new Set(rows.map((r) => r.cycle).filter(Boolean)).size, [rows])
  const start = rowOf(draft.start)
  const end = rowOf(draft.end)
  const at = selected ? order.get(selected.index) ?? null : null
  // 끝 스텝은 시작 스텝보다 앞일 수 없다
  const canEnd = at !== null && start !== null && at >= (order.get(start.index) ?? 0)
  const label = (r: ResultRow) => `#${r.index + 1} ${r.name}`
  const everyCycle = draft.everyCycle && cycles > 1

  const pickStart = () => {
    if (at === null || !selected) return
    // 끝 스텝이 새 시작보다 앞이면 끝은 다시 고른다
    setDraft({ ...draft, start: selected.index, end: draft.end !== null && (order.get(draft.end) ?? 0) < at ? null : draft.end })
  }
  const editing = state.excludes.some((x) => x.id === draft.editing) ? draft.editing : null
  const add = () => {
    if (!start || !end) return
    const ex = { id: editing ?? newId(), start: start.index, end: end.index, everyCycle }
    state.setExcludes(editing ? state.excludes.map((x) => (x.id === editing ? ex : x)) : [...state.excludes, ex])
    setDraft({ ...draft, start: null, end: null, editing: null })
  }
  // 목록의 제외 구간을 고르는 칸으로 불러와 고친다 (같은 걸 다시 누르면 그만둠)
  const edit = (ex: Exclusion) => {
    if (editing === ex.id) setDraft({ ...draft, start: null, end: null, editing: null })
    else setDraft({ start: ex.start, end: ex.end, everyCycle: ex.everyCycle, editing: ex.id })
  }
  const remove = (id: string) => {
    state.setExcludes(state.excludes.filter((x) => x.id !== id))
    if (editing === id) setDraft({ ...draft, start: null, end: null, editing: null })
  }

  return (
    <div className="rv-va-exclude">
      <div className="rv-trim-bar">
        <strong className="small">⛔ 제외 구간</strong>
        <span className="small muted ellipsis" translate="no">{selected ? label(selected) : ''}</span>
        <span className="small muted">{selected ? '고른 행을' : '표에서 행을 고르세요'}</span>
        <button type="button" className="primary" disabled={!selected} onClick={pickStart} title="표에서 고른 행을 시작 스텝으로">시작 스텝</button>
        <button
          type="button"
          className="primary"
          disabled={!canEnd}
          onClick={() => selected && setDraft({ ...draft, end: selected.index })}
          title={!start ? '시작 스텝을 먼저 정하세요' : selected && !canEnd ? '시작 스텝보다 앞 행은 끝 스텝으로 고를 수 없습니다' : '표에서 고른 행을 끝 스텝으로'}
        >
          끝 스텝
        </button>
        {cycles > 1 && (
          <label className="small" title="Cycle마다 같은 스텝(이름과 그 Cycle 안에서 몇 번째인지) 사이를 뺍니다 — 켜 두면 표에는 첫 Cycle만 보입니다">
            <input type="checkbox" checked={draft.everyCycle} onChange={(e) => setDraft({ ...draft, everyCycle: e.target.checked })} />
            모든 Cycle
          </label>
        )}
        {everyCycle && <span className="small muted">표는 첫 Cycle만</span>}
        <button type="button" disabled={!start || !end} onClick={add} title={editing ? '고르던 제외 구간을 이 시작·끝 스텝으로 바꿉니다' : '시작 스텝 ~ 끝 스텝이 끝날 때까지를 검출에서 뺍니다'}>
          {editing ? '바꾸기' : '추가'}
        </button>
        {editing && <button type="button" onClick={() => setDraft({ ...draft, start: null, end: null, editing: null })} title="고치지 않고 그대로 둡니다">취소</button>}
        <span className="rv-spacer" />
        <button type="button" onClick={() => state.setExcludeEdit(false)} title="닫기 (Esc) — 추가한 구간은 그대로 뺍니다">닫기</button>
      </div>
      {(start || end) && (
        <div className="rv-va-exclude-draft small">
          {editing && <strong>고치는 중</strong>}
          <span className="muted">시작</span>
          <span className="ellipsis" translate="no">{start ? label(start) : '-'}</span>
          <span className="muted">끝</span>
          <span className="ellipsis" translate="no">{end ? label(end) : '-'}</span>
          {start && end && <span className="muted">{everyCycle ? `모든 Cycle · 구간 ${spansOf({ id: '', start: start.index, end: end.index, everyCycle }, rows).length}개` : '구간 1개'}</span>}
        </div>
      )}
      {state.excludes.length > 0 && (
        <ul className="rv-va-exclude-list small">
          {state.excludes.map((ex) => {
            const s = rowOf(ex.start)
            const e = rowOf(ex.end)
            const places = spansOf(ex, rows).length
            return (
              <li key={ex.id} className={editing === ex.id ? 'editing' : undefined}>
                <span className="ellipsis" translate="no">{`${s ? label(s) : '?'} ~ ${e ? label(e) : '?'}`}</span>
                <span className="muted">{ex.everyCycle ? `모든 Cycle · 구간 ${places}개` : `구간 ${places}개`}</span>
                <button type="button" className="icon" aria-label="고치기" aria-pressed={editing === ex.id} title={editing === ex.id ? '고치기 그만두기' : '이 제외 구간 고치기 — 시작·끝 스텝을 다시 골라 [바꾸기]'} onClick={() => edit(ex)}>✎</button>
                <button type="button" className="icon" aria-label="빼기" title="이 제외 구간 지우기" onClick={() => remove(ex.id)}>✕</button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
