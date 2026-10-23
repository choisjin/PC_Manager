import { useEffect, useRef, useState } from 'react'
import { api, type VideoAnalysisChunk, type VideoAnalysisProgress } from '../../api'
import type { Box } from './frameUtil'
import type { FrameShot, SearchVideo } from './imageSearchState'
import { toMessage } from './resultSessions'
import { Detector, type DetectResult, type FrameArrays, type SegmentKind } from './videoDetect'

// 결과 확인: 영상 분석 (ReplayKit_FailAnalyzer 영상 페이지의 영상 분석을 옮김)
//   1) 테스트 PC 에이전트가 이 실행의 영상들을 ffmpeg로 프레임마다 잰다: 화면 영역의 밝기·프레임 차이·윤곽·
//      윤곽이 가장 많은 칸·평균 색(·베젤 테두리 밝기). 긴 영상은 앞 구간부터 재고 조각(1MB)으로 돌려준다
//   2) 받는 대로 앞에서부터 이어진 부분만 판정한다 (검은 화면·깜박임·정지 구간·화면 전환 — videoDetect)
//   3) 정지 기준을 바꾸면 다시 재지 않고 받은 프레임으로 바로 다시 판정한다

/** 영상 아래 탐색 막대에 그리는 검출 구간 색 */
export const MARK_COLOR: Record<SegmentKind, string> = { black_screen: '#c9392f', flicker: '#d4972a', static: '#8a93a3' }

/** 화면 영역: 에이전트가 추정 · 화면 전체 · 직접 지정 (베젤은 직접 지정일 때만) */
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
  /** 베젤 테두리 밝기 (베젤이 없으면 0) */
  b: Float32Array
  /** 화면 − 베젤 대비 (베젤이 있으면 이것으로 판정) */
  c: Float32Array
  /** 평균 색 R·G·B (프레임마다 3) · 채도 (RGB 최대 − 최소) */
  rgb: Uint8Array
  sat: Uint8Array
  done: boolean
  error: string | null
}

/** 쓴 분석 조건 (에이전트가 정한 화면 영역 포함) */
export interface AnalysisSetup {
  roi: Box | null
  roiSource: string | null
  bezel: Box | null
}

// 에이전트가 잠깐 다시 연결하는 동안 묻기 실패를 견디는 횟수 (1초 간격 → 약 30초)
const MAX_FAILURES = 30
// 프레임 한 장 (에이전트 VideoAnalyzer.FrameBytes): ReplayKit_FailAnalyzer와 같은 정밀도 (시각 float64, 값 float32)
const FRAME_BYTES = 31

function newFrames(path: string, capacity = 4096): VideoFrames {
  return {
    path, n: 0, t: new Float64Array(capacity), y: new Float32Array(capacity), d: new Float32Array(capacity), e: new Float32Array(capacity),
    g: new Float32Array(capacity), b: new Float32Array(capacity), c: new Float32Array(capacity), rgb: new Uint8Array(capacity * 3),
    sat: new Uint8Array(capacity), done: false, error: null,
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
    e: grow(f.e, (n) => new Float32Array(n)), g: grow(f.g, (n) => new Float32Array(n)), b: grow(f.b, (n) => new Float32Array(n)),
    c: grow(f.c, (n) => new Float32Array(n)), rgb: grow(f.rgb, (n) => new Uint8Array(n), 3), sat: grow(f.sat, (n) => new Uint8Array(n)),
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
    out.b[i] = view.getFloat32(o + 24, true)
    out.c[i] = Math.max(0, out.y[i] - out.b[i])
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

/** 판정 입력 (앞 n개): 베젤이 있으면 밝기 대신 화면 − 베젤 대비 */
function arraysOf(f: VideoFrames, n: number, bezel: boolean): FrameArrays {
  return { n, t: f.t, y: bezel ? f.c : f.y, e: f.e, d: f.d, g: f.g, bz: bezel ? f.b : null, sat: f.sat }
}

/**
 * 오버레이(영상 위 화면 영역 표시)·패널·영역 고르기 창이 함께 쓰는 상태와 분석 작업.
 * 패널을 닫아도(스텝 이미지를 보려고) 결과·진행 중인 분석은 그대로 두고, 다시 열면 이어서 본다
 */
export function useVideoAnalysis(agentId: string, videos: SearchVideo[]) {
  const [open, setOpen] = useState(false)
  const [roiMode, setRoiMode] = useState<RoiMode>('auto')
  const [customRoi, setCustomRoi] = useState<Box | null>(null)
  const [bezel, setBezel] = useState<Box | null>(null)
  // 정지 구간 기준 (초): 바꾸면 받은 프레임으로 바로 다시 판정
  const [staticS, setStaticS] = useState(10)
  // 영상 위에 화면 영역(빨강)·베젤(노랑) 표시
  const [showRoi, setShowRoi] = useState(true)
  // 열린 영역 고르기 창 (지금 프레임에서 화면 영역 또는 베젤)
  const [picking, setPicking] = useState<{ kind: 'screen' | 'bezel'; frame: FrameShot } | null>(null)
  const [frames, setFrames] = useState<VideoFrames[]>([])
  const [results, setResults] = useState<DetectResult[]>([])
  const [setup, setSetup] = useState<AnalysisSetup | null>(null)
  const [status, setStatus] = useState<{ state: VideoAnalysisProgress['state']; progress: number; current: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  // 묻기가 실패해 다시 묻는 중 (에이전트 연결이 잠깐 끊김)
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
  const bezelRef = useRef(false)
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
  }

  /** i번째 영상: 아직 판정하지 않은 구간 경계마다 판정 (마지막 경계는 다 받았으면 끝까지 닫음). close: 멈춤·오류 — 받은 데까지 닫는다 */
  const feedVideo = (i: number, close: boolean) => {
    const f = framesRef.current[i]
    if (!f) return
    const det = (detectorsRef.current[i] ??= new Detector(staticRef.current))
    const marks = marksRef.current[i] ?? []
    let k = fedRef.current[i] ?? 0
    for (; k < marks.length; k++) det.feed(arraysOf(f, marks[k], bezelRef.current), f.done && k === marks.length - 1)
    fedRef.current[i] = k
    if (f.done || close) det.feed(arraysOf(f, f.n, bezelRef.current), true)
  }

  /** 받은 프레임을 판정하고 화면에 넘긴다 */
  const publish = (touched: Set<number>, close: boolean) => {
    for (let i = 0; i < framesRef.current.length; i++) if (touched.has(i) || close) feedVideo(i, close)
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
    setFrames([])
    setResults([])
    setSetup(null)
    setError(null)
    setStatus(null)
    setRetrying(false)
    setElapsed(null)
    setPicked(null)
    setRunning(true)
    const started = Date.now()
    const roi = roiMode === 'full' ? [0, 0, 1, 1] : roiMode === 'custom' ? customRoi : null
    try {
      const { id } = await api.startVideoAnalysis(agentId, {
        paths: videos.map((v) => v.readPath),
        roi,
        bezel: roiMode === 'custom' && customRoi ? bezel : null,
      })
      jobRef.current = id
      let video = 0
      let offset = 0
      let more = false
      let failures = 0
      for (;;) {
        if (!more) await new Promise((r) => window.setTimeout(r, 1000))
        // 다른 분석을 시작했거나 결과 화면을 벗어남
        if (jobRef.current !== id) return
        let next: VideoAnalysisProgress
        try {
          next = await api.videoAnalysisChunks(agentId, id, video, offset)
        } catch (err) {
          // 작업이 없어졌으면(에이전트 다시 시작) 바로 그만, 아니면 다시 연결될 때까지 묻는다
          if ((err as { status?: number }).status === 404 || ++failures > MAX_FAILURES) throw err
          setRetrying(true)
          more = false
          continue
        }
        if (jobRef.current !== id) return
        failures = 0
        setRetrying(false)
        if (next.roi) {
          bezelRef.current = !!next.bezel
          setSetup({ roi: next.roi as Box, roiSource: next.roiSource, bezel: (next.bezel as Box | null) ?? null })
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
    open, setOpen, close, roiMode, setRoiMode, customRoi, setCustomRoi, bezel, setBezel, staticS, changeStatic, showRoi, setShowRoi,
    picking, setPicking, frames, results, setup, status, error, running, retrying, elapsed, run, stop, picked, setPicked,
  }
}

export type VideoAnalysisState = ReturnType<typeof useVideoAnalysis>
