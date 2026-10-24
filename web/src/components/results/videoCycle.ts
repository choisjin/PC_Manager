import type { ResultRow } from './resultCsv'
import type { VideoFrames } from './videoAnalysisState'
import { bisectLeft, pyRound } from './videoDetect'
import { stepKeys } from './videoExclude'

// 영상 분석 Cycle 비교: 첫 Cycle을 기준으로 이후 Cycle의 같은 스텝(이름과 그 Cycle 안에서 몇 번째인지) 동안의 화면을 비교해 다른 곳(특이점)을 찾는다.
// 스텝 시작부터 지난 시간(BIN_S 칸)마다 화면 밝기·평균 색을 기준 Cycle과 견주고, Result 시각과 영상의 어긋남·애니메이션 속도 차이는
// 앞뒤 SHIFT_BINS 칸 안에서 가장 비슷한 칸과 견줘 흡수한다. 차이가 MIN_BINS 칸 넘게 이어진 곳만 특이점 (잠깐 튄 것은 뺀다)

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

/** 탐색 막대·그래프·목록의 Cycle 비교 색 */
export const CYCLE_COLOR = '#0f9aa8'

/** 기본 밝기 차이 기준 (0~255) */
export const CYCLE_DIFF_DEFAULT = 25

/** 특이점 하나: Cycle의 스텝 안에서 기준 Cycle과 다르게 보인 구간 */
export interface CycleAnomaly {
  key: string
  cycle: string
  /** 이 Cycle의 스텝 · 기준 Cycle의 같은 스텝 */
  row: ResultRow
  refRow: ResultRow
  /** 영상 (VideoFrames 차례) · 영상 안 초 */
  video: number
  start: number
  end: number
  /** 스텝 시작부터 (초) */
  offset: number
  /** 기준 Cycle의 같은 자리 (영상 · 영상 안 초) */
  refVideo: number
  refAt: number
  /** 가장 다른 곳의 밝기 (기준 → 이 Cycle) · 평균 색 차이 (채널 최대) */
  refBright: number
  bright: number
  colorDiff: number
}

/** 이 Cycle 스텝 구간을 기준 Cycle 스텝에 겹쳐 보는 짝 (그래프에 기준 밝기를 겹쳐 그린다) */
export interface CycleMap {
  /** 이 영상 안 구간 (초) */
  start: number
  end: number
  refVideo: number
  refStart: number
}

export interface CycleCompare {
  /** 기준 Cycle (첫 Cycle) */
  ref: string
  anomalies: CycleAnomaly[]
  /** 영상마다 겹쳐 볼 짝 */
  maps: CycleMap[][]
  /** 견준 스텝 수 */
  compared: number
}

interface Span {
  row: ResultRow
  video: number
  start: number
  end: number
}

/** 칸마다 평균 밝기·색 (프레임이 없는 칸은 NaN) */
function profile(f: VideoFrames, start: number, bins: number) {
  const y = new Float64Array(bins).fill(NaN)
  const rgb = new Float64Array(bins * 3)
  let i = bisectLeft(f.t, start, f.n)
  for (let b = 0; b < bins; b++) {
    const until = start + (b + 1) * BIN_S
    let sum = 0
    let r = 0
    let g = 0
    let bl = 0
    let k = 0
    for (; i < f.n && f.t[i] < until; i++) {
      sum += f.y[i]
      r += f.rgb[i * 3]
      g += f.rgb[i * 3 + 1]
      bl += f.rgb[i * 3 + 2]
      k++
    }
    if (!k) continue
    y[b] = sum / k
    rgb[b * 3] = r / k
    rgb[b * 3 + 1] = g / k
    rgb[b * 3 + 2] = bl / k
  }
  return { y, rgb }
}

/**
 * 첫 Cycle 기준 비교.
 * rows: 시각이 있는 Result 행 (시각순) · position: 행의 영상 위치 (영상 차례, 초) · frames: 영상마다 잰 프레임 ·
 * diff: 밝기 차이 기준 (0~255) · excluded: 영상마다 제외 구간 (그 안의 특이점은 뺀다)
 */
export function compareCycles(
  rows: ResultRow[],
  position: (row: ResultRow) => { video: number; seconds: number } | null,
  frames: (VideoFrames | undefined)[],
  diff: number,
  excluded: [number, number][][],
): CycleCompare | null {
  const cycles = [...new Set(rows.map((r) => r.cycle).filter(Boolean))]
  if (cycles.length < 2) return null
  const ref = cycles[0]
  const keys = stepKeys(rows)
  // 행마다 영상 구간: 시작 ~ 걸린 시간(없으면 다음 스텝 시작)
  const spans: Span[] = []
  rows.forEach((row, i) => {
    const at = position(row)
    if (!at || !frames[at.video]?.n) return
    const next = rows[i + 1]
    const ms = row.durationMs ?? (next?.time != null ? next.time - row.time! : 0)
    const len = Math.min(MAX_STEP_S, ms / 1000)
    if (len <= 2 * EDGE_S + MIN_BINS * BIN_S) return
    spans.push({ row, video: at.video, start: at.seconds, end: at.seconds + len })
  })
  const refSpans = new Map<string, Span>()
  for (const s of spans) {
    const key = keys.get(s.row.index)
    if (s.row.cycle === ref && key && !refSpans.has(key)) refSpans.set(key, s)
  }
  const inside = (video: number, t: number) => (excluded[video] ?? []).some(([a, b]) => a <= t && t <= b)
  const tyLimit = diff
  const tcLimit = diff * COLOR_RATIO
  const anomalies: CycleAnomaly[] = []
  const maps: CycleMap[][] = frames.map(() => [])
  let compared = 0
  for (const s of spans) {
    if (s.row.cycle === ref || !s.row.cycle) continue
    const key = keys.get(s.row.index)
    const r = key ? refSpans.get(key) : undefined
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
    // 칸마다: 기준의 앞뒤 칸 중 가장 비슷한 칸과의 차이 (기준 넘음 = 1 이상)
    const score = new Float64Array(bins)
    const best = new Int32Array(bins)
    for (let k = edge; k < bins - edge; k++) {
      if (Number.isNaN(a.y[k])) continue
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
      score[k] = low === Infinity ? 0 : low
    }
    // 기준을 넘는 칸이 MIN_BINS 넘게 이어진 곳마다 특이점 하나 (가장 다른 칸의 값으로)
    for (let k = edge; k < bins - edge;) {
      if (score[k] < 1) {
        k++
        continue
      }
      let e = k
      let top = k
      while (e < bins - edge && score[e] >= 1) {
        if (score[e] > score[top]) top = e
        e++
      }
      const t0 = s.start + k * BIN_S
      if (e - k >= MIN_BINS && !inside(s.video, t0)) {
        const j = best[top]
        anomalies.push({
          key: `c:${s.row.index}:${k}`,
          cycle: s.row.cycle,
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
        })
      }
      k = e
    }
  }
  anomalies.sort((x, y) => x.video - y.video || x.start - y.start)
  return { ref, anomalies, maps, compared }
}
