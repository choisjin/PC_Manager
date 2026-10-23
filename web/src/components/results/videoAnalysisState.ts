import { useEffect, useRef, useState } from 'react'
import { api, type VideoAnalysisChunk, type VideoAnalysisProgress } from '../../api'
import type { Quad } from './frameUtil'
import type { FrameShot, SearchVideo } from './imageSearchState'
import { toMessage } from './resultSessions'
import { Detector, type DetectResult, type FrameArrays, type SegmentKind } from './videoDetect'
import type { Exclusion } from './videoExclude'

// 결과 확인: 영상 분석 (ReplayKit_FailAnalyzer 영상 페이지의 영상 분석을 옮김)
//   1) 테스트 PC 에이전트가 이 실행의 영상들을 ffmpeg로 프레임마다 잰다: 화면 영역의 밝기·프레임 차이·윤곽·
//      윤곽이 가장 많은 칸·평균 색. 긴 영상은 앞 구간부터 재고 조각(1MB)으로 돌려준다
//   2) 받는 대로 앞에서부터 이어진 부분만 판정한다 (검은 화면·깜박임·정지 구간·화면 전환 — videoDetect).
//      꺼진 화면은 기준 밝기(그 영상에서 0.3초 넘게 이어진 가장 낮은 밝기)와의 차이로 본다:
//      받는 중에 더 어두운 곳이 나오면 기준 밝기를 낮추고 그 영상을 처음부터 다시 판정한다
//   3) 정지 기준을 바꾸면 다시 재지 않고 받은 프레임으로 바로 다시 판정한다. 제외 구간은 판정 결과에서 뺀다 (videoExclude)

/** 영상 아래 탐색 막대에 그리는 검출 구간 색 */
export const MARK_COLOR: Record<SegmentKind, string> = { black_screen: '#c9392f', flicker: '#d4972a', static: '#8a93a3' }

/** 화면 영역: 에이전트가 추정 · 화면 전체 · 직접 지정 */
export type RoiMode = 'auto' | 'full' | 'custom'

/** 받은 프레임 (영상 하나): 앞 n개만 유효, 모자라면 두 배로 늘린다 (20시간 30fps ≈ 216만 프레임 ≈ 80MB) */
export interface VideoFrames {
  path: string
  n: number
  /** 영상 안 초 */
  t: Float64Array
  /** 화면 밝기 */
  y: Float32Array
  /** 직전 프레임과의 차이 */
  d: Float32Array
  /** 윤곽 (화면 평균) */
  e: Float32Array
  /** 윤곽이 가장 많은 칸 (8×4) */
  g: Float32Array
  /** 밝기 − 기준 밝기 (꺼진 화면을 이것으로 판정, 기준 밝기가 낮아지면 다시 계산) */
  c: Float32Array
  /** 평균 색 R·G·B (프레임마다 3) · 채도 (RGB 최대 − 최소) */
  rgb: Uint8Array
  sat: Uint8Array
  /** 판정에 쓴 기준 밝기: 그 영상에서 0.3초 넘게 이어진 가장 낮은 밝기 (받는 중에 낮아질 수 있음, 받기 전이면 null) */
  floor: number | null
  done: boolean
  error: string | null
}

/** 쓴 분석 조건 (에이전트가 정한 화면 영역): 직사각형 [x0, y0, x1, y1] 또는 꼭짓점 넷 (비율) */
export interface AnalysisSetup {
  roi: number[] | null
  roiSource: string | null
}

// 묻기 실패를 견디는 시간: 서버가 다시 시작하거나(업데이트 등) 에이전트가 다시 연결하는 동안.
// 에이전트는 2분 동안 아무도 묻지 않으면 작업을 버리므로 그보다 조금 짧게
const RETRY_MS = 110_000
// 프레임 한 장 (에이전트 VideoAnalyzer.FrameBytes): ReplayKit_FailAnalyzer와 같은 정밀도 (시각 float64, 값 float32).
// 베젤 밝기 자리(+24)는 이제 쓰지 않는다
const FRAME_BYTES = 31
// 기준 밝기: 이 시간 넘게 이어진 가장 낮은 밝기 (한두 프레임 튄 값은 무시 — 0.3초 미만 빈 화면은 검은 화면이 아닌 것과 같게)
const FLOOR_WIN_S = 0.3
// 기준 밝기가 이만큼 넘게 낮아질 때만 처음부터 다시 판정 (잡음으로 조금씩 낮아질 때마다 다시 하지 않게)
const FLOOR_STEP = 0.5

function newFrames(path: string, capacity = 4096): VideoFrames {
  return {
    path, n: 0, t: new Float64Array(capacity), y: new Float32Array(capacity), d: new Float32Array(capacity), e: new Float32Array(capacity),
    g: new Float32Array(capacity), c: new Float32Array(capacity), rgb: new Uint8Array(capacity * 3), sat: new Uint8Array(capacity),
    floor: null, done: false, error: null,
  }
}

/** 자리가 모자라면 두 배로 (앞 n개를 옮긴다) */
function reserve(f: VideoFrames, size: number): VideoFrames {
  if (size <= f.t.length) return f
  const capacity = Math.max(size, f.t.length * 2)
  const grow = <T extends Float64Array | Float32Array | Uint8Array>(a: T, make: (n: number) => T, k = 1) => {
    const out = make(capacity * k)
    out.set(a.subarray(0, f.n * k))
    return out
  }
  return {
    ...f,
    t: grow(f.t, (n) => new Float64Array(n)), y: grow(f.y, (n) => new Float32Array(n)), d: grow(f.d, (n) => new Float32Array(n)),
    e: grow(f.e, (n) => new Float32Array(n)), g: grow(f.g, (n) => new Float32Array(n)), c: grow(f.c, (n) => new Float32Array(n)),
    rgb: grow(f.rgb, (n) => new Uint8Array(n), 3), sat: grow(f.sat, (n) => new Uint8Array(n)),
  }
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** 조각을 이어 붙인다 (이미 받은 앞부분은 건너뜀). 새 객체를 돌려준다 (화면이 바뀐 것을 알게) */
function append(f: VideoFrames, chunk: VideoAnalysisChunk): VideoFrames {
  const bytes = fromBase64(chunk.frames)
  const count = Math.floor(bytes.length / FRAME_BYTES)
  const skip = Math.max(0, f.n - chunk.offset)
  let out = reserve(f, f.n + Math.max(0, count - skip))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let i = out.n
  for (let k = skip; k < count; k++, i++) {
    const o = k * FRAME_BYTES
    out.t[i] = view.getFloat64(o, true)
    out.y[i] = view.getFloat32(o + 8, true)
    out.d[i] = view.getFloat32(o + 12, true)
    out.e[i] = view.getFloat32(o + 16, true)
    out.g[i] = view.getFloat32(o + 20, true)
    const r = bytes[o + 28]
    const g = bytes[o + 29]
    const b = bytes[o + 30]
    out.rgb[i * 3] = r
    out.rgb[i * 3 + 1] = g
    out.rgb[i * 3 + 2] = b
    out.sat[i] = Math.max(r, g, b) - Math.min(r, g, b)
  }
  out = { ...out, n: i }
  if (chunk.done) out = { ...out, done: true, error: chunk.error }
  return out
}

/** 기준 밝기 찾기 (영상 하나, 받은 만큼 이어서): 0.3초 창 안 최댓값들 중 가장 작은 값 */
interface FloorScan {
  pos: number
  /** 창 안 프레임 번호 (밝기가 줄어드는 차례, head부터 유효) */
  queue: number[]
  head: number
  low: number
}

function scanFloor(s: FloorScan, f: VideoFrames): number {
  const { t, y } = f
  for (let i = s.pos; i < f.n; i++) {
    while (s.queue.length > s.head && y[s.queue[s.queue.length - 1]] <= y[i]) s.queue.pop()
    s.queue.push(i)
    while (t[s.queue[s.head]] < t[i] - FLOOR_WIN_S) s.head++
    if (t[i] - t[0] >= FLOOR_WIN_S) s.low = Math.min(s.low, y[s.queue[s.head]])
  }
  s.pos = f.n
  if (s.head > 4096) {
    s.queue = s.queue.slice(s.head)
    s.head = 0
  }
  if (s.low !== Infinity) return s.low
  // 0.3초가 안 되는 영상: 가장 낮은 밝기
  let low = Infinity
  for (let i = 0; i < f.n; i++) low = Math.min(low, y[i])
  return low
}

/** 판정 입력 (앞 n개): 꺼진 화면은 밝기 − 기준 밝기로, 깜박임은 화면 밝기로 */
function arraysOf(f: VideoFrames, n: number): FrameArrays {
  return { n, t: f.t, y: f.y, c: f.floor !== null ? f.c : null, e: f.e, d: f.d, g: f.g, floor: f.floor, sat: f.sat }
}

/**
 * 오버레이(영상 위 화면 영역 표시)·패널·영역 고르기 창이 함께 쓰는 상태와 분석 작업.
 * 패널을 닫아도(스텝 이미지를 보려고) 결과·진행 중인 분석은 그대로 두고, 다시 열면 이어서 본다
 */
export function useVideoAnalysis(agentId: string, videos: SearchVideo[]) {
  const [open, setOpen] = useState(false)
  const [roiMode, setRoiMode] = useState<RoiMode>('auto')
  // 직접 지정한 화면: 꼭짓점 넷 (비스듬히 찍힌 화면도 그대로, 에이전트가 반듯하게 펴서 잰다)
  const [customRoi, setCustomRoi] = useState<Quad | null>(null)
  // 정지 구간 기준 (초): 바꾸면 받은 프레임으로 바로 다시 판정
  const [staticS, setStaticS] = useState(10)
  // 영상 위에 화면 영역(빨강) 표시
  const [showRoi, setShowRoi] = useState(true)
  // 열린 영역 고르기 창의 프레임 (지금 프레임)
  const [picking, setPicking] = useState<FrameShot | null>(null)
  // 제외 구간 (Result 표의 스텝으로) · 제외 구간 고르는 중 (결과 표 위에 고르는 줄)
  const [excludes, setExcludes] = useState<Exclusion[]>([])
  const [excludeEdit, setExcludeEdit] = useState(false)
  const [frames, setFrames] = useState<VideoFrames[]>([])
  const [results, setResults] = useState<DetectResult[]>([])
  const [setup, setSetup] = useState<AnalysisSetup | null>(null)
  const [status, setStatus] = useState<{ state: VideoAnalysisProgress['state']; progress: number; current: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 분석은 되지만 알아야 할 것 (꼭짓점 영역을 모르는 옛 에이전트 등)
  const [warning, setWarning] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  // 묻기가 실패해 다시 묻는 중 (서버·에이전트 연결이 잠깐 끊김)
  const [retrying, setRetrying] = useState(false)
  // 분석에 걸린 시간 (시작~끝, 초)
  const [elapsed, setElapsed] = useState<number | null>(null)
  // 마지막으로 누른 검출 항목 (`종류:경로:시작`) — 스크롤해도 어디를 봤는지 보이게
  const [picked, setPicked] = useState<string | null>(null)
  const jobRef = useRef<string | null>(null)
  // 받은 프레임·판정기 (받는 루프가 이어 쓴다. 화면에는 frames·results로 넘긴다)
  const framesRef = useRef<VideoFrames[]>([])
  const detectorsRef = useRef<Detector[]>([])
  // 영상마다 측정 구간이 끝난 자리(프레임 수)와 그중 판정한 수: ReplayKit_FailAnalyzer처럼 구간이 끝날 때마다 판정한다
  // (기준값을 구하는 창이 판정 시점에 따라 달라지므로 같은 결과를 내려면 같은 경계에서)
  const marksRef = useRef<number[][]>([])
  const fedRef = useRef<number[]>([])
  // 영상마다 기준 밝기 찾기 · 밝기 − 기준 밝기를 채운 프레임 수
  const scansRef = useRef<FloorScan[]>([])
  const filledRef = useRef<number[]>([])
  // 받는 루프는 시작할 때의 정지 기준을 쓰지 않게 (바꾸면 다시 판정)
  const staticRef = useRef(staticS)

  // 결과 화면을 벗어나면 진행 중인 분석을 멈춘다
  useEffect(() => () => {
    const id = jobRef.current
    jobRef.current = null
    if (id) void api.cancelVideoAnalysis(agentId, id).catch(() => {})
  }, [agentId])

  const close = () => {
    setOpen(false)
    setPicking(null)
    setExcludeEdit(false)
  }

  /** i번째 영상: 아직 판정하지 않은 구간 경계마다 판정 (마지막 경계는 다 받았으면 끝까지 닫음). close: 멈춤·오류 — 받은 데까지 닫는다 */
  const feedVideo = (i: number, close: boolean) => {
    const f = framesRef.current[i]
    if (!f) return
    const det = (detectorsRef.current[i] ??= new Detector(staticRef.current))
    const marks = marksRef.current[i] ?? []
    let k = fedRef.current[i] ?? 0
    for (; k < marks.length; k++) det.feed(arraysOf(f, marks[k]), f.done && k === marks.length - 1)
    fedRef.current[i] = k
    if (f.done || close) det.feed(arraysOf(f, f.n), true)
  }

  /** i번째 영상의 기준 밝기를 받은 데까지 찾는다: 넘게 낮아졌으면 밝기 − 기준 밝기를 다시 채우고 처음부터 다시 판정 */
  const updateFloor = (i: number) => {
    const f = framesRef.current[i]
    if (!f?.n) return
    const low = scanFloor((scansRef.current[i] ??= { pos: 0, queue: [], head: 0, low: Infinity }), f)
    let from = filledRef.current[i] ?? 0
    if (f.floor === null || low <= f.floor - FLOOR_STEP) {
      framesRef.current[i] = { ...f, floor: low }
      detectorsRef.current[i] = new Detector(staticRef.current)
      fedRef.current[i] = 0
      from = 0
    }
    const { c, y, n } = framesRef.current[i]
    const floor = framesRef.current[i].floor!
    for (let k = from; k < n; k++) c[k] = Math.max(0, y[k] - floor)
    filledRef.current[i] = n
  }

  /** 받은 프레임을 판정하고 화면에 넘긴다 */
  const publish = (touched: Set<number>, close: boolean) => {
    for (let i = 0; i < framesRef.current.length; i++) {
      if (!touched.has(i) && !close) continue
      updateFloor(i)
      feedVideo(i, close)
    }
    setFrames([...framesRef.current])
    setResults(detectorsRef.current.map((d) => d.result()))
  }

  const run = async () => {
    if (jobRef.current) void api.cancelVideoAnalysis(agentId, jobRef.current).catch(() => {})
    jobRef.current = null
    framesRef.current = []
    detectorsRef.current = []
    marksRef.current = []
    fedRef.current = []
    scansRef.current = []
    filledRef.current = []
    setFrames([])
    setResults([])
    setSetup(null)
    setError(null)
    setWarning(null)
    setStatus(null)
    setRetrying(false)
    setElapsed(null)
    setPicked(null)
    setRunning(true)
    const started = Date.now()
    const roi = roiMode === 'full' ? [0, 0, 1, 1] : roiMode === 'custom' ? customRoi : null
    try {
      const { id } = await api.startVideoAnalysis(agentId, { paths: videos.map((v) => v.readPath), roi })
      jobRef.current = id
      let video = 0
      let offset = 0
      let more = false
      // 묻기가 처음 실패한 때 (이어서 실패하는 동안)
      let failingSince: number | null = null
      for (;;) {
        if (!more) await new Promise((r) => window.setTimeout(r, 1000))
        // 다른 분석을 시작했거나 결과 화면을 벗어남
        if (jobRef.current !== id) return
        let next: VideoAnalysisProgress
        try {
          next = await api.videoAnalysisChunks(agentId, id, video, offset)
        } catch (err) {
          // 작업이 없어졌으면(에이전트 다시 시작) 바로 그만, 아니면 다시 연결될 때까지 묻는다
          failingSince ??= Date.now()
          if ((err as { status?: number }).status === 404 || Date.now() - failingSince > RETRY_MS) throw err
          setRetrying(true)
          more = false
          continue
        }
        if (jobRef.current !== id) return
        failingSince = null
        setRetrying(false)
        if (next.roi) {
          setSetup({ roi: next.roi, roiSource: next.roiSource })
          // 꼭짓점 넷을 보냈는데 직사각형이 왔다 = 꼭짓점을 모르는 옛 에이전트 (화면 영역을 추정해 잰다)
          if (roiMode === 'custom' && customRoi && next.roi.length !== 8) {
            setWarning('이 PC의 에이전트는 꼭짓점으로 지정한 영역을 몰라 화면 영역을 추정해 잽니다. 에이전트를 업데이트하세요')
          }
        }
        const touched = new Set<number>()
        for (const chunk of next.chunks) {
          const prev = framesRef.current[chunk.video] ?? newFrames(videos[chunk.video]?.path ?? chunk.path)
          framesRef.current[chunk.video] = append(prev, chunk)
          const marks = (marksRef.current[chunk.video] ??= [])
          for (const m of chunk.marks ?? []) if (m > (marks.at(-1) ?? 0)) marks.push(m)
          touched.add(chunk.video)
          if (chunk.done) {
            video = chunk.video + 1
            offset = 0
          } else {
            video = chunk.video
            offset = framesRef.current[chunk.video].n
          }
        }
        more = next.more
        const finished = next.state !== 'running' && !more
        if (touched.size || finished) publish(touched, finished)
        setStatus({ state: next.state, progress: next.progress, current: next.current })
        if (finished) {
          if (next.state === 'failed') setError(next.error ?? '분석하지 못했습니다')
          break
        }
      }
      setElapsed((Date.now() - started) / 1000)
      jobRef.current = null
      setRunning(false)
    } catch (err) {
      setError(toMessage(err))
      setRetrying(false)
      jobRef.current = null
      setRunning(false)
      // 거기까지 받은 것은 판정을 닫아 둔다
      if (framesRef.current.length) publish(new Set(), true)
    }
  }

  const stop = () => {
    if (jobRef.current) void api.cancelVideoAnalysis(agentId, jobRef.current).catch(() => {})
  }

  /** 정지 기준을 바꾸면 받은 프레임으로 처음부터 다시 판정 (같은 구간 경계에서) */
  const changeStatic = (seconds: number) => {
    setStaticS(seconds)
    staticRef.current = seconds
    detectorsRef.current = []
    fedRef.current = []
    for (let i = 0; i < framesRef.current.length; i++) feedVideo(i, !running)
    setResults(detectorsRef.current.map((d) => d.result()))
  }

  return {
    open, setOpen, close, roiMode, setRoiMode, customRoi, setCustomRoi, staticS, changeStatic, showRoi, setShowRoi,
    picking, setPicking, excludes, setExcludes, excludeEdit, setExcludeEdit,
    frames, results, setup, status, error, warning, running, retrying, elapsed, run, stop, picked, setPicked,
  }
}

export type VideoAnalysisState = ReturnType<typeof useVideoAnalysis>
