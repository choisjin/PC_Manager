import type { ResultRow } from './resultCsv'
import type { VideoFrames } from './videoAnalysisState'
import { bisectLeft, type DetectedSegment, type DetectResult, pyRound } from './videoDetect'
import { stepKeys } from './videoExclude'

// 영상 분석 Cycle 비교: 기준 Cycle(사용자가 정상 동작을 확인한 Cycle, 기본은 첫 Cycle)을 기준으로 이후 Cycle의 같은 스텝(이름과 그
// Cycle 안에서 몇 번째인지)을 견줘 이상 증상을 찾는다. 시각은 스텝 시작부터 지난 시간으로 맞춘다 (Result 시각과 영상의 어긋남·스텝 길이 차이를 흡수).
//   ① 꺼짐: 깜박임·검은 화면을 기준 Cycle의 같은 자리(±EVENT_TOL_S) 꺼짐과 짝지어 추가 · 빠짐 · 길어짐/짧아짐 (짝이 맞으면 정상)
//   ② 반응: 화면 전환을 기준 Cycle의 전환과 순서를 지켜 짝지어 지연(지연 기준 넘게 늦음) · 반응 없음(기준엔 있던 전환이 없음).
//      꺼짐의 시작·끝 전환은 ①에서 보므로 뺀다
//   ③ 멈춤: 정지 구간인데 기준 Cycle은 그동안 대부분 정지가 아님
//   ④ 화면: BIN_S 칸마다 밝기·평균 색, 축소 이미지가 있으면 칸별 화면을 기준의 앞뒤 SHIFT_BINS 칸 중 가장 비슷한 칸과 견줘 MIN_BINS 칸 넘게
//      이어진 곳 — 화면 전체가 다르면 화면 다름, 일부 칸만 다르면 화면 깨짐 (꺼짐 동안은 ①에서 보므로 뺀다)

/** 비교 칸 (초) */
const BIN_S = 0.2
/** 기준 Cycle과 견줄 때 앞뒤로 봐 주는 칸 (±0.6초) */
const SHIFT_BINS = 3
/** 이만큼(0.6초) 넘게 이어져야 특이점 */
const MIN_BINS = 3
/** 스텝 시작·끝의 이만큼(초)은 견주지 않는다 (스텝이 바뀌는 순간의 화면 전환) */
const EDGE_S = 0.4
/** 한 스텝에서 견주는 최대 길이 (초) */
const MAX_STEP_S = 600
/** 평균 색 차이 기준 = 밝기 차이 기준 × 이 배 (색은 채널 하나가 크게 바뀌어도 밝기는 덜 바뀐다) */
const COLOR_RATIO = 1.5
/** 꺼짐 짝: 같은 스텝에서 시점이 이 안(초)이면 같은 꺼짐 (정상 Cycle끼리는 0.3초 안) */
const EVENT_TOL_S = 1
/** 꺼짐 길이가 이만큼(초) 넘게, 그리고 기준 길이의 이 비율 넘게 다르면 길어짐/짧아짐 */
const OFF_DUR_ABS = 0.5
const OFF_DUR_REL = 0.3
/** 화면 전환 짝짓기 (순서를 지키는 정렬): 짝이 없을 때 치르는 값(초) · 기준보다 이만큼 이르거나 늦은 것까지만 짝 */
const GAP_S = 5
const EARLY_S = 1
const LATE_S = 10
/** 정렬 표 칸 수 한도 (넘으면 차례로 가까운 것끼리) */
const MAX_DP = 4_000_000
/** 꺼짐 앞뒤 여유 (초): 이 안의 화면 전환은 꺼짐의 시작·끝으로 본다 (켜지며 밝아지는 동안 전환이 잡히기도 한다) */
const OFF_MARGIN_S = 0.6
/** 멈춤: 정지 구간 중 기준 Cycle도 정지였던 비율이 이보다 작으면 */
const FROZEN_SHARE = 0.5
/** 이 Cycle 영상을 아직 다 재지 않았으면 잰 끝에서 이만큼(초) 앞까지만 빠짐·반응 없음을 판정 */
const TAIL_S = 3

/** 축소 이미지 (에이전트 VideoAnalyzer.Thumb*): 16×9 회색, 시각 8바이트 + 화소 */
export const THUMB_W = 16
export const THUMB_H = 9
export const THUMB_CELLS = THUMB_W * THUMB_H
export const THUMB_BYTES = 8 + THUMB_CELLS
/** 칸이 다르다: 기준을 이 Cycle 밝기에 맞게 늘이고 옮긴 뒤(노출 차이를 지움) 차이가 이 값(0~255) 넘음 */
const CELL_DIFF = 24
/** 화면 깨짐: 다른 칸이 이만큼 이상이고 전체의 이 비율 이하 (넘으면 화면 다름) */
const CORRUPT_MIN_CELLS = 3
const CORRUPT_MAX_SHARE = 0.5
/**
 * 화면이 움직이는 칸(애니메이션·전환 중)은 칸별로 견주지 않는다: 칸의 평균 프레임 차이가 평소 변화의 ACTIVE_X배(최소 ACTIVE_MIN) 넘음.
 * 시험 영상: 멈춘 화면 0.25~0.35, 부팅 로고 애니메이션 3~12 (애니메이션 속도가 Cycle마다 달라 칸이 다르게 보인다)
 */
const ACTIVE_X = 4
const ACTIVE_MIN = 1

/** 탐색 막대·그래프·목록의 Cycle 비교 색 */
export const CYCLE_COLOR = '#0f9aa8'

/** 기본 밝기 차이 기준 (0~255) */
export const CYCLE_DIFF_DEFAULT = 25
/** 기본 지연 기준 (초): 화면 전환이 기준 Cycle보다 이만큼 넘게 늦으면 지연 (정상 Cycle끼리는 0.2초 안) */
export const DELAY_DEFAULT = 0.5

/** 이상 증상 종류 */
export type AnomalyKind = 'screen' | 'corrupt' | 'off-extra' | 'off-missing' | 'off-longer' | 'off-shorter' | 'delay' | 'no-response' | 'frozen'

/** 꺼짐 하나 (깜박임 묶음 또는 검은 화면) */
export interface OffEvent {
  kind: 'flicker' | 'black_screen'
  dur: number
  /** 깜박임 횟수 (검은 화면은 1) */
  count: number
}

interface AnomalyBase {
  key: string
  cycle: string
  /** 이 Cycle의 스텝 · 기준 Cycle의 같은 스텝 */
  row: ResultRow
  refRow: ResultRow
  /** 영상 (VideoFrames 차례) · 영상 안 초 (그래프·탐색 막대에 칠하는 구간) */
  video: number
  start: number
  end: number
  /** 스텝 시작부터 (초) */
  offset: number
  /** 기준 Cycle의 같은 자리 (영상 · 영상 안 초) */
  refVideo: number
  refAt: number
}
/** 화면 다름 · 화면 깨짐: 가장 다른 곳의 밝기 (기준 → 이 Cycle) · 평균 색 차이 (채널 최대) · 축소 이미지로 견줬으면 다른 칸 */
export interface ScreenAnomaly extends AnomalyBase {
  kind: 'screen' | 'corrupt'
  refBright: number
  bright: number
  colorDiff: number
  /** 다른 칸 수 (가장 많을 때) · 그 칸들 (0 ~ THUMB_CELLS−1, 왼쪽 위부터 가로로) · 몰린 곳. 축소 이미지가 없으면 null */
  cells: number | null
  mask: number[] | null
  region: string | null
}
/** 꺼짐: 이 Cycle의 꺼짐 (빠짐이면 null) · 기준 Cycle의 꺼짐 (추가면 null) */
export interface OffAnomaly extends AnomalyBase {
  kind: 'off-extra' | 'off-missing' | 'off-longer' | 'off-shorter'
  off: OffEvent | null
  refOff: OffEvent | null
}
/** 지연: 화면 전환이 기준 Cycle보다 늦은 시간 (초). start = 기준대로라면 바뀌었을 때, end = 실제로 바뀐 때 */
export interface DelayAnomaly extends AnomalyBase {
  kind: 'delay'
  lag: number
}
/** 반응 없음: 기준 Cycle엔 있던 화면 전환이 없음 · 그때 이 Cycle 화면이 정지 구간이었는지 (꺼져 있던 때는 꺼짐으로 나오므로 뺀다) */
export interface ResponseAnomaly extends AnomalyBase {
  kind: 'no-response'
  during: 'static' | null
}
/** 멈춤: 정지 구간인데 기준 Cycle은 그동안 화면이 바뀜 */
export interface FrozenAnomaly extends AnomalyBase {
  kind: 'frozen'
  seconds: number
}
export type CycleAnomaly = ScreenAnomaly | OffAnomaly | DelayAnomaly | ResponseAnomaly | FrozenAnomaly

/** 이 Cycle 스텝 구간을 기준 Cycle 스텝에 겹쳐 보는 짝 (그래프에 기준 밝기를 겹쳐 그린다) */
export interface CycleMap {
  /** 이 영상 안 구간 (초) */
  start: number
  end: number
  refVideo: number
  refStart: number
}

export interface CycleCompare {
  /** 기준 Cycle · Result의 Cycle들 (차례대로) */
  ref: string
  cycles: string[]
  anomalies: CycleAnomaly[]
  /** 영상마다 겹쳐 볼 짝 */
  maps: CycleMap[][]
  /** 화면을 견준 스텝 수 */
  compared: number
  /** 검출 목록 표시 (markKey → 기준 Cycle에도 있음 · 기준 Cycle의 것) */
  marks: Map<string, 'normal' | 'ref'>
  /** 축소 이미지로 화면을 칸별로 견줬다 (옛 에이전트면 false: 화면 깨짐을 못 본다) */
  thumbs: boolean
}

export interface CompareOptions {
  /** 밝기 차이 기준 (0~255) */
  diff: number
  /** 지연 기준 (초) */
  delayS: number
  /** 기준 Cycle (없거나 Result에 없으면 첫 Cycle) */
  refCycle: string | null
}

/** 검출 목록의 표시 열쇠: 영상 차례 · 종류 · 시작 (초, 검출 그대로) */
export const markKey = (video: number, kind: string, start: number) => `${video}:${kind}:${start}`

interface Span {
  row: ResultRow
  cycle: string
  key: string
  video: number
  start: number
  end: number
}

/** 검출 하나 (꺼짐·정지 구간·화면 전환)와 그것이 든 스텝 */
interface Ev {
  video: number
  t: number
  end: number
  s: Span
  seg: DetectedSegment | null
}

/** 칸마다 평균 밝기·색·프레임 차이 (프레임이 없는 칸은 밝기 NaN) */
function profile(f: VideoFrames, start: number, bins: number) {
  const y = new Float64Array(bins).fill(NaN)
  const rgb = new Float64Array(bins * 3)
  const d = new Float64Array(bins)
  let i = bisectLeft(f.t, start, f.n)
  for (let b = 0; b < bins; b++) {
    const until = start + (b + 1) * BIN_S
    let sum = 0
    let r = 0
    let g = 0
    let bl = 0
    let dd = 0
    let k = 0
    for (; i < f.n && f.t[i] < until; i++) {
      sum += f.y[i]
      r += f.rgb[i * 3]
      g += f.rgb[i * 3 + 1]
      bl += f.rgb[i * 3 + 2]
      dd += f.d[i]
      k++
    }
    if (!k) continue
    y[b] = sum / k
    rgb[b * 3] = r / k
    rgb[b * 3 + 1] = g / k
    rgb[b * 3 + 2] = bl / k
    d[b] = dd / k
  }
  return { y, rgb, d }
}

/** 시각 t에 가장 가까운 축소 이미지 차례 (BIN_S 안에 없으면 -1) */
function thumbAt(f: VideoFrames, t: number): number {
  const i = bisectLeft(f.tt, t, f.tn)
  let best = -1
  let d = Infinity
  for (const k of [i - 1, i]) {
    if (k < 0 || k >= f.tn || Math.abs(f.tt[k] - t) >= d) continue
    best = k
    d = Math.abs(f.tt[k] - t)
  }
  return d <= BIN_S ? best : -1
}

/**
 * 축소 이미지 칸별 비교: 기준(b)을 이 Cycle(a) 밝기에 맞게 늘이고 옮긴 뒤(노출·조명 차이를 지움 — 가장 다른 20% 칸은 빼고 한 번 더 맞춤)
 * 차이가 CELL_DIFF 넘는 칸들
 */
export function cellDiff(a: Uint8Array, ao: number, b: Uint8Array, bo: number): number[] {
  const n = THUMB_CELLS
  const fit = (keep: (i: number) => boolean) => {
    let sa = 0
    let sb = 0
    let k = 0
    for (let i = 0; i < n; i++) {
      if (!keep(i)) continue
      sa += a[ao + i]
      sb += b[bo + i]
      k++
    }
    const ma = sa / k
    const mb = sb / k
    let cov = 0
    let vb = 0
    for (let i = 0; i < n; i++) {
      if (!keep(i)) continue
      const db = b[bo + i] - mb
      cov += (a[ao + i] - ma) * db
      vb += db * db
    }
    const gain = vb > 1e-6 ? Math.min(2, Math.max(0.5, cov / vb)) : 1
    return { gain, offset: ma - gain * mb }
  }
  let m = fit(() => true)
  const res = new Float64Array(n)
  for (let i = 0; i < n; i++) res[i] = Math.abs(a[ao + i] - (m.gain * b[bo + i] + m.offset))
  const cut = Float64Array.from(res).sort()[Math.floor(n * 0.8)]
  m = fit((i) => res[i] <= cut)
  const out: number[] = []
  for (let i = 0; i < n; i++) if (Math.abs(a[ao + i] - (m.gain * b[bo + i] + m.offset)) > CELL_DIFF) out.push(i)
  return out
}

const NO_CELLS: number[] = []

/** cellDiff 앞의 빠른 확인: 평균만 맞춰도 모든 칸 차이가 CELL_DIFF 이하면 다른 칸 없음 (대부분의 칸이 여기서 끝난다) */
function cellDiffQuick(a: Uint8Array, ao: number, b: Uint8Array, bo: number): number[] {
  let sa = 0
  let sb = 0
  for (let i = 0; i < THUMB_CELLS; i++) {
    sa += a[ao + i]
    sb += b[bo + i]
  }
  const offset = (sa - sb) / THUMB_CELLS
  for (let i = 0; i < THUMB_CELLS; i++) if (Math.abs(a[ao + i] - b[bo + i] - offset) > CELL_DIFF) return cellDiff(a, ao, b, bo)
  return NO_CELLS
}

/** 다른 칸들이 몰린 곳 (가운데 기준 3×3): 왼쪽 위 · 위 · 오른쪽 위 · 왼쪽 · 가운데 · … */
function regionOf(cells: Iterable<number>): string | null {
  let sx = 0
  let sy = 0
  let k = 0
  for (const c of cells) {
    sx += (c % THUMB_W) + 0.5
    sy += Math.floor(c / THUMB_W) + 0.5
    k++
  }
  if (!k) return null
  const x = sx / k / THUMB_W
  const y = sy / k / THUMB_H
  const col = x < 1 / 3 ? '왼쪽' : x > 2 / 3 ? '오른쪽' : ''
  const row = y < 1 / 3 ? '위' : y > 2 / 3 ? '아래' : ''
  return col && row ? `${col} ${row}` : col || row || '가운데'
}

/**
 * 기준 전환 시각 g와 이 Cycle 전환 시각 c(둘 다 기준 Cycle 시각, ms, 정렬됨)를 순서를 지켜 짝짓는다:
 * 짝의 값은 어긋난 초, 짝이 없으면 GAP_S (기준보다 EARLY_S 넘게 이르거나 LATE_S 넘게 늦으면 짝이 될 수 없다)
 */
function align(g: number[], c: number[]): [number, number][] {
  const m = g.length
  const n = c.length
  if (!m || !n) return []
  const cost = (i: number, j: number) => {
    const lag = (c[j] - g[i]) / 1000
    return lag < -EARLY_S || lag > LATE_S ? Infinity : Math.abs(lag)
  }
  if ((m + 1) * (n + 1) > MAX_DP) {
    // 너무 크면 기준 전환마다 아직 안 쓴 다음 전환 중 짝이 될 수 있는 첫 것
    const out: [number, number][] = []
    let j = 0
    for (let i = 0; i < m; i++) {
      while (j < n && (c[j] - g[i]) / 1000 < -EARLY_S) j++
      if (j < n && cost(i, j) < Infinity) out.push([i, j++])
    }
    return out
  }
  const w = n + 1
  const dp = new Float64Array((m + 1) * w)
  // 1 = 기준만 (빠짐) · 2 = 이 Cycle만 (추가) · 3 = 짝
  const move = new Uint8Array((m + 1) * w)
  for (let i = 1; i <= m; i++) {
    dp[i * w] = i * GAP_S
    move[i * w] = 1
  }
  for (let j = 1; j <= n; j++) {
    dp[j] = j * GAP_S
    move[j] = 2
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      let best = dp[(i - 1) * w + j] + GAP_S
      let mv = 1
      const skip = dp[i * w + j - 1] + GAP_S
      if (skip < best) {
        best = skip
        mv = 2
      }
      const pair = dp[(i - 1) * w + j - 1] + cost(i - 1, j - 1)
      if (pair < best) {
        best = pair
        mv = 3
      }
      dp[i * w + j] = best
      move[i * w + j] = mv
    }
  }
  const out: [number, number][] = []
  for (let i = m, j = n; i > 0 || j > 0;) {
    const mv = move[i * w + j]
    if (mv === 3) {
      out.push([i - 1, j - 1])
      i--
      j--
    } else if (mv === 1) i--
    else j--
  }
  return out.reverse()
}

const offEvent = (seg: DetectedSegment): OffEvent => ({
  kind: seg.kind === 'flicker' ? 'flicker' : 'black_screen',
  dur: seg.dur,
  count: seg.info.type === 'flicker' ? seg.info.count : 1,
})

/**
 * 기준 Cycle 기준 비교.
 * rows: 시각이 있는 Result 행 (시각순) · position: 행의 영상 위치 (영상 차례, 초) · frames: 영상마다 잰 프레임 ·
 * results: 영상마다 제외 구간을 뺀 검출 · excluded: 영상마다 제외 구간 (그 안은 판정하지 않는다)
 */
export function compareCycles(
  rows: ResultRow[],
  position: (row: ResultRow) => { video: number; seconds: number } | null,
  frames: (VideoFrames | undefined)[],
  results: (DetectResult | undefined)[],
  opts: CompareOptions,
  excluded: [number, number][][],
): CycleCompare | null {
  const cycles = [...new Set(rows.map((r) => r.cycle).filter(Boolean))]
  if (cycles.length < 2) return null
  const ref = opts.refCycle && cycles.includes(opts.refCycle) ? opts.refCycle : cycles[0]
  const keys = stepKeys(rows)
  // 행마다 영상 구간: 시작 ~ 걸린 시간(없으면 다음 스텝 시작)
  const spans: Span[] = []
  rows.forEach((row, i) => {
    const at = position(row)
    const key = keys.get(row.index)
    if (!at || !key || !row.cycle || row.time === null || !frames[at.video]?.n) return
    const next = rows[i + 1]
    const ms = row.durationMs ?? (next?.time != null ? next.time - row.time : 0)
    spans.push({ row, cycle: row.cycle, key, video: at.video, start: at.seconds, end: at.seconds + Math.min(MAX_STEP_S, Math.max(0, ms / 1000)) })
  })
  const byCycle = new Map<string, Map<string, Span>>()
  for (const s of spans) {
    const m = byCycle.get(s.cycle) ?? new Map<string, Span>()
    if (!m.has(s.key)) m.set(s.key, s)
    byCycle.set(s.cycle, m)
  }
  const refByKey = byCycle.get(ref) ?? new Map<string, Span>()
  const refSorted = [...refByKey.values()].sort((a, b) => a.row.time! - b.row.time!)

  // (영상, 초)가 든 스텝: 시작이 그 앞인 마지막 스텝 (그 스텝이 끝나고 LATE_S초 넘게 지났으면 없음)
  const byVideo: Span[][] = frames.map(() => [])
  for (const s of spans) byVideo[s.video]?.push(s)
  for (const list of byVideo) list.sort((a, b) => a.start - b.start)
  const find = (video: number, t: number): Span | null => {
    const list = byVideo[video]
    if (!list?.length) return null
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].start <= t + 1e-6) lo = mid + 1
      else hi = mid
    }
    const s = list[lo - 1]
    return s && t <= s.end + LATE_S ? s : null
  }
  // 기준 Cycle 시각(ms)으로: 기준 Cycle 것은 그대로, 다른 Cycle은 기준 Cycle 같은 스텝 시작 + 같은 오프셋
  const ownWall = (s: Span, t: number) => s.row.time! + (t - s.start) * 1000
  const toRef = (s: Span, t: number) => {
    const r = refByKey.get(s.key)
    return r ? { r, wall: r.row.time! + (t - s.start) * 1000, at: r.start + (t - s.start) } : null
  }
  // 기준 Cycle 시각(ms) → cycle의 같은 자리
  const fromRef = (wall: number, cycle: string) => {
    let lo = 0
    let hi = refSorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (refSorted[mid].row.time! <= wall) lo = mid + 1
      else hi = mid
    }
    const r = refSorted[lo - 1]
    const s = r ? byCycle.get(cycle)?.get(r.key) : undefined
    if (!r || !s) return null
    const offset = (wall - r.row.time!) / 1000
    return { s, video: s.video, t: s.start + offset, offset }
  }
  // 제외 구간 안 (끝은 밖: 테스트 시작 등 경계에 딱 맞는 것은 견준다)
  const inside = (video: number, t: number) => (excluded[video] ?? []).some(([a, b]) => a <= t && t < b)
  // 판정할 수 있는 끝: 다 잰 영상은 끝까지, 재는 중이면 잰 끝에서 조금 앞까지
  const measuredEnd = (video: number) => {
    const f = frames[video]
    return !f?.n ? -Infinity : f.done ? Infinity : f.t[f.n - 1] - TAIL_S
  }

  // 검출을 스텝에 붙인다: 꺼짐(깜박임·검은 화면) · 정지 구간 · 화면 전환
  const offs: Ev[] = []
  const statics: Ev[] = []
  const trans: Ev[] = []
  // 영상마다 꺼짐 구간 (화면 전환·비교 칸을 뺄 때)
  const offSpans: [number, number, 'black_screen' | 'flicker'][][] = frames.map(() => [])
  const staticSpans: [number, number][][] = frames.map(() => [])
  results.forEach((r, video) => {
    if (!r) return
    for (const seg of r.segments) {
      if (seg.kind === 'static') staticSpans[video].push([seg.start, seg.end])
      else offSpans[video].push([seg.start, seg.end, seg.kind])
      const s = find(video, seg.start)
      if (!s) continue
      const ev = { video, t: seg.start, end: seg.end, s, seg }
      if (seg.kind === 'static') statics.push(ev)
      else offs.push(ev)
    }
  })
  // 시작순 구간들에서 t를 덮는 것 (구간은 겹치지 않으므로 시작이 t + margin 앞인 마지막 몇 개만 본다 — 긴 영상의 칸마다 부르므로 이진 탐색)
  for (const list of [...offSpans, ...staticSpans]) list.sort((x, y) => x[0] - y[0])
  const cover = <T extends [number, number, ...unknown[]]>(list: T[] | undefined, t: number, margin: number): T | null => {
    if (!list?.length) return null
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid][0] - margin <= t) lo = mid + 1
      else hi = mid
    }
    for (let i = lo - 1; i >= Math.max(0, lo - 3); i--) if (t <= list[i][1] + margin) return list[i]
    return null
  }
  const offAt = (video: number, t: number, margin: number) => cover(offSpans[video], t, margin)?.[2] ?? null
  const staticAt = (video: number, t: number) => cover(staticSpans[video], t, 0) !== null
  results.forEach((r, video) => {
    for (const t of r?.transitions ?? []) {
      // 꺼짐의 시작·끝 전환은 꺼짐 비교에서 본다
      if (offAt(video, t, OFF_MARGIN_S)) continue
      const s = find(video, t)
      if (s) trans.push({ video, t, end: t, s, seg: null })
    }
  })

  const marks = new Map<string, 'normal' | 'ref'>()
  for (const e of [...offs, ...statics]) if (e.s.cycle === ref) marks.set(markKey(e.video, e.seg!.kind, e.seg!.start), 'ref')
  const anomalies: CycleAnomaly[] = []
  const base = (cycle: string, s: Span, refRow: ResultRow, video: number, start: number, end: number, refVideo: number, refAt: number) => ({
    cycle, row: s.row, refRow, video, start: pyRound(start, 2), end: pyRound(end, 2), offset: pyRound(start - s.start, 2), refVideo, refAt: pyRound(refAt, 2),
  })
  const byWall = <T extends { wall: number }>(a: T, b: T) => a.wall - b.wall
  const refOffs = offs.filter((e) => e.s.cycle === ref).map((e) => ({ e, wall: ownWall(e.s, e.t) })).sort(byWall)
  const refTrans = trans.filter((e) => e.s.cycle === ref).map((e) => ({ e, wall: ownWall(e.s, e.t) })).sort(byWall)
  const refStatics = statics.filter((e) => e.s.cycle === ref).map((e) => [ownWall(e.s, e.t), ownWall(e.s, e.end)] as [number, number])

  for (const cycle of cycles) {
    if (cycle === ref || !byCycle.has(cycle)) continue
    // 이 Cycle의 검출을 기준 Cycle 시각으로 (이 Cycle이나 기준 쪽 자리가 제외 구간이면 견주지 않는다)
    const mapped = (list: Ev[]) => list.filter((e) => e.s.cycle === cycle && !inside(e.video, e.t)).flatMap((e) => {
      const m = toRef(e.s, e.t)
      return m && !inside(m.r.video, m.at) ? [{ e, ...m }] : []
    }).sort(byWall)
    // 기준 Cycle 검출 중 이 Cycle에서 볼 수 있는 것 (같은 스텝이 있고, 제외 구간 밖, 잰 범위 안)
    const visible = <T extends { wall: number }>(list: T[]) => list.flatMap((g) => {
      const p = fromRef(g.wall, cycle)
      return p && !inside(p.video, p.t) && p.t <= measuredEnd(p.video) ? [{ ...g, p }] : []
    })

    // ① 꺼짐: 같은 자리(±EVENT_TOL_S) 짝 → 길이 비교, 짝이 없으면 추가 · 기준에만 있으면 빠짐
    const used = new Set<number>()
    for (const x of mapped(offs)) {
      let best = -1
      let gap = EVENT_TOL_S * 1000
      refOffs.forEach((g, i) => {
        const d = Math.abs(g.wall - x.wall)
        if (!used.has(i) && d <= gap) {
          best = i
          gap = d
        }
      })
      const seg = x.e.seg!
      const off = offEvent(seg)
      if (best < 0) {
        anomalies.push({ ...base(cycle, x.e.s, x.r.row, x.e.video, seg.start, seg.end, x.r.video, x.at), key: `o:${x.e.video}:${seg.start}`, kind: 'off-extra', off, refOff: null })
        continue
      }
      used.add(best)
      const g = refOffs[best]
      const refOff = offEvent(g.e.seg!)
      const diff = off.dur - refOff.dur
      if (Math.abs(diff) > Math.max(OFF_DUR_ABS, OFF_DUR_REL * refOff.dur)) {
        anomalies.push({
          ...base(cycle, x.e.s, g.e.s.row, x.e.video, seg.start, seg.end, g.e.video, g.e.t),
          key: `o:${x.e.video}:${seg.start}`, kind: diff > 0 ? 'off-longer' : 'off-shorter', off, refOff,
        })
      } else marks.set(markKey(x.e.video, seg.kind, seg.start), 'normal')
    }
    for (const g of visible(refOffs.filter((_, i) => !used.has(i)))) {
      const refOff = offEvent(g.e.seg!)
      anomalies.push({
        ...base(cycle, g.p.s, g.e.s.row, g.p.video, g.p.t, g.p.t + refOff.dur, g.e.video, g.e.t),
        key: `m:${g.p.video}:${pyRound(g.p.t, 2)}`, kind: 'off-missing', off: null, refOff,
      })
    }

    // ② 반응: 화면 전환을 순서대로 짝지어 지연 · 반응 없음
    const gs = visible(refTrans)
    const cs = mapped(trans)
    const paired = new Set<number>()
    for (const [gi, ci] of align(gs.map((g) => g.wall), cs.map((c) => c.wall))) {
      paired.add(gi)
      const g = gs[gi]
      const c = cs[ci]
      const lag = (c.wall - g.wall) / 1000
      if (lag <= opts.delayS) continue
      const from = g.p.video === c.e.video ? Math.min(g.p.t, c.e.t) : Math.max(0, c.e.t - lag)
      anomalies.push({
        ...base(cycle, g.p.s, g.e.s.row, c.e.video, from, c.e.t, g.e.video, g.e.t),
        offset: pyRound(g.p.offset, 2), key: `d:${c.e.video}:${c.e.t}`, kind: 'delay', lag: pyRound(lag, 2),
      })
    }
    gs.forEach((g, gi) => {
      if (paired.has(gi)) return
      // 그때 이 Cycle이 꺼져 있었으면 꺼짐(추가·길어짐)으로 이미 나온다
      if (offAt(g.p.video, g.p.t, OFF_MARGIN_S)) return
      const during = staticAt(g.p.video, g.p.t) ? 'static' : null
      anomalies.push({
        ...base(cycle, g.p.s, g.e.s.row, g.p.video, g.p.t, g.p.t + 2 * BIN_S, g.e.video, g.e.t),
        key: `n:${g.p.video}:${pyRound(g.p.t, 2)}`, kind: 'no-response', during,
      })
    })

    // ③ 멈춤: 정지 구간 중 기준 Cycle도 정지였던 비율이 작으면
    for (const x of mapped(statics)) {
      const seg = x.e.seg!
      const w1 = x.wall + seg.dur * 1000
      let overlap = 0
      for (const [a, b] of refStatics) overlap += Math.max(0, Math.min(w1, b) - Math.max(x.wall, a))
      if (overlap >= FROZEN_SHARE * (w1 - x.wall)) {
        marks.set(markKey(x.e.video, seg.kind, seg.start), 'normal')
        continue
      }
      anomalies.push({
        ...base(cycle, x.e.s, x.r.row, x.e.video, seg.start, seg.end, x.r.video, x.at),
        key: `f:${x.e.video}:${seg.start}`, kind: 'frozen', seconds: seg.dur,
      })
    }
  }

  // ④ 화면: 스텝마다 칸별로
  const tyLimit = opts.diff
  const tcLimit = opts.diff * COLOR_RATIO
  const maps: CycleMap[][] = frames.map(() => [])
  let compared = 0
  let thumbsUsed = false
  for (const s of spans) {
    if (s.cycle === ref) continue
    const r = refByKey.get(s.key)
    if (!r) continue
    const fa = frames[s.video]!
    const fr = frames[r.video]!
    const len = Math.min(s.end - s.start, r.end - r.start)
    const bins = Math.floor(len / BIN_S)
    const edge = Math.ceil(EDGE_S / BIN_S)
    if (bins - 2 * edge < MIN_BINS) continue
    compared++
    maps[s.video].push({ start: s.start, end: s.start + len, refVideo: r.video, refStart: r.start })
    const a = profile(fa, s.start, bins)
    const b = profile(fr, r.start, bins)
    const thumbs = fa.tn > 0 && fr.tn > 0
    if (thumbs) thumbsUsed = true
    // 화면이 움직이는 칸의 기준 (영상마다 평소 변화로)
    const activeA = Math.max(ACTIVE_MIN, ACTIVE_X * (results[s.video]?.ref?.noise ?? 0.3))
    const activeB = Math.max(ACTIVE_MIN, ACTIVE_X * (results[r.video]?.ref?.noise ?? 0.3))
    // 칸마다: 기준의 앞뒤 칸 중 가장 비슷한 칸과의 밝기·색 차이 (기준 넘음 = 1 이상) · 다른 축소 이미지 칸들 · 견주지 않는 칸
    const score = new Float64Array(bins)
    const best = new Int32Array(bins)
    const cells: (number[] | null)[] = new Array<number[] | null>(bins).fill(null)
    const skip = new Uint8Array(bins)
    for (let k = edge; k < bins - edge; k++) {
      const ta = s.start + (k + 0.5) * BIN_S
      if (Number.isNaN(a.y[k]) || inside(s.video, ta) || offAt(s.video, ta, BIN_S)) {
        skip[k] = 1
        continue
      }
      let low = Infinity
      for (let j = Math.max(0, k - SHIFT_BINS); j <= Math.min(bins - 1, k + SHIFT_BINS); j++) {
        if (Number.isNaN(b.y[j])) continue
        const dy = Math.abs(a.y[k] - b.y[j])
        const dc = Math.max(
          Math.abs(a.rgb[k * 3] - b.rgb[j * 3]), Math.abs(a.rgb[k * 3 + 1] - b.rgb[j * 3 + 1]), Math.abs(a.rgb[k * 3 + 2] - b.rgb[j * 3 + 2]),
        )
        const sc = Math.max(dy / tyLimit, dc / tcLimit)
        if (sc < low) {
          low = sc
          best[k] = j
        }
      }
      // 기준 쪽이 꺼져 있던 칸도 뺀다 (꺼짐 비교에서 본다)
      if (low === Infinity || offAt(r.video, r.start + (best[k] + 0.5) * BIN_S, BIN_S)) {
        skip[k] = 1
        continue
      }
      score[k] = low
      if (!thumbs) continue
      // 축소 이미지: 밝기로 고른 기준 칸과 그 앞뒤 칸 중 가장 덜 다른 것 (어느 쪽이든 화면이 움직이는 중이면 견주지 않는다)
      const ia = thumbAt(fa, ta)
      const j0 = Math.max(0, best[k] - 1)
      const j1 = Math.min(bins - 1, best[k] + 1)
      let moving = a.d[k] > activeA
      for (let j = j0; j <= j1; j++) if (b.d[j] > activeB) moving = true
      if (ia < 0 || moving) continue
      // 가장 비슷한 칸부터: 다른 칸이 없으면 앞뒤는 보지 않는다
      for (const j of [best[k], best[k] - 1, best[k] + 1]) {
        if (j < j0 || j > j1) continue
        const ib = thumbAt(fr, r.start + (j + 0.5) * BIN_S)
        if (ib < 0) continue
        const diff = cellDiffQuick(fa.tp, ia * THUMB_CELLS, fr.tp, ib * THUMB_CELLS)
        if (!cells[k] || diff.length < cells[k]!.length) cells[k] = diff
        if (!diff.length) break
      }
    }
    const bad = (k: number) => !skip[k] && (score[k] >= 1 || (cells[k]?.length ?? 0) >= CORRUPT_MIN_CELLS)
    // 다른 칸이 MIN_BINS 넘게 이어진 곳마다 하나: 밝기·색이 다르거나 칸 절반 넘게 다르면 화면 다름, 아니면 화면 깨짐
    for (let k = edge; k < bins - edge;) {
      if (!bad(k)) {
        k++
        continue
      }
      let e = k
      let top = k
      let global = false
      let most = 0
      const union = new Set<number>()
      while (e < bins - edge && bad(e)) {
        if (score[e] > score[top]) top = e
        const n = cells[e]?.length ?? 0
        if (score[e] >= 1 || n > CORRUPT_MAX_SHARE * THUMB_CELLS) global = true
        most = Math.max(most, n)
        for (const c of cells[e] ?? []) union.add(c)
        e++
      }
      if (e - k >= MIN_BINS) {
        const j = best[top]
        const t0 = s.start + k * BIN_S
        anomalies.push({
          key: `c:${s.row.index}:${k}`,
          kind: global ? 'screen' : 'corrupt',
          cycle: s.cycle,
          row: s.row,
          refRow: r.row,
          video: s.video,
          start: pyRound(t0, 2),
          end: pyRound(s.start + e * BIN_S, 2),
          offset: pyRound(k * BIN_S, 2),
          refVideo: r.video,
          refAt: pyRound(r.start + k * BIN_S, 2),
          refBright: pyRound(b.y[j], 1),
          bright: pyRound(a.y[top], 1),
          colorDiff: Math.round(Math.max(
            Math.abs(a.rgb[top * 3] - b.rgb[j * 3]), Math.abs(a.rgb[top * 3 + 1] - b.rgb[j * 3 + 1]), Math.abs(a.rgb[top * 3 + 2] - b.rgb[j * 3 + 2]),
          )),
          cells: thumbs ? most : null,
          mask: thumbs ? [...union].sort((x, y) => x - y) : null,
          region: thumbs && !global ? regionOf(union) : null,
        })
      }
      k = e
    }
  }
  anomalies.sort((x, y) => x.video - y.video || x.start - y.start)
  return { ref, cycles, anomalies, maps, compared, marks, thumbs: thumbsUsed }
}
