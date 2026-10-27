import type { ResultRow } from './resultCsv'
import type { VideoFrames } from './videoAnalysisState'
import { bisectLeft, type DetectedSegment, type DetectResult, MIN_BLACK_S, pyRound } from './videoDetect'
import { stepKeys } from './videoExclude'

// 영상 분석 메모 구간: 고른 Cycle(보통 정상 동작을 확인한 첫 Cycle)의 영상 구간에 메모를 남기면 (예: 켜질 때 웰컴 애니메이션 = "부팅 로드 중")
// 모든 Cycle의 같은 자리에서 고른 Cycle에 있던 것과 같은 검출(같은 종류 · 구간 시작부터 같은 자리 ±tol초 · 비슷한 길이)은 뺀다.
// 고른 Cycle에 없던 검출(새로 생긴 깜박임 등)은 그대로 둔다. 같은 자리 = 같은 스텝(이름과 그 Cycle 안에서 몇 번째인지)의 같은 오프셋에서
// 밝기 흐름이 가장 비슷하게 겹치도록 ±SHIFT_S초 안에서 맞춘 곳 (부팅처럼 Cycle마다 몇 초씩 늦고 이른 곳). 구간 안은 Cycle 비교의 화면 비교를 하지 않는다

/** 밝기 흐름으로 맞출 때 스텝 자리에서 앞뒤로 찾는 범위 (초) */
const SHIFT_S = 5
/** 밝기 흐름 칸 (초): 긴 구간은 칸 수가 MAX_BINS를 넘지 않게 넓힌다 */
const BIN_S = 0.1
const MAX_BINS = 1200
/** 덜 옮긴 쪽을 고르는 값: 밝기 단계 / 초 (밝기가 평평해 어디든 같으면 스텝 자리 그대로) */
const SHIFT_PENALTY = 0.3
/** 화면 전환 짝: 구간 시작부터 같은 자리 (초) */
const TRANSITION_TOL_S = 0.5

/** 메모 구간: 시작·끝 = 스텝(ResultRow.index)과 그 스텝 영상 위치부터 초. everyCycle이면 모든 Cycle의 같은 자리에서도 뺀다 */
export interface MemoSpan {
  id: string
  memo: string
  start: number
  from: number
  end: number
  to: number
  everyCycle: boolean
}

/** 메모 구간이 놓인 자리 (Cycle마다): 영상 차례 · 영상 안 초 · 메모를 단 Cycle인지 · 스텝 자리에서 밝기 흐름으로 옮긴 초 */
export interface MemoPlace {
  id: string
  memo: string
  cycle: string
  source: boolean
  video: number
  start: number
  end: number
  shift: number
}

/** 메모를 다는 자리: 영상 위치가 든 스텝(그 영상에서 위치가 앞인 마지막 스텝)과 스텝 위치부터 초. rows: 시각순 */
export function anchorAt(
  rows: ResultRow[],
  position: (row: ResultRow) => { video: number; seconds: number } | null,
  video: number,
  seconds: number,
): { row: ResultRow; offset: number } | null {
  let best: { row: ResultRow; at: number } | null = null
  for (const row of rows) {
    const p = position(row)
    if (!p || p.video !== video || p.seconds > seconds + 1e-6) continue
    if (!best || p.seconds >= best.at) best = { row, at: p.seconds }
  }
  return best && { row: best.row, offset: pyRound(seconds - best.at, 3) }
}

/** 구간 [t0, t1)의 칸마다 평균 밝기 (프레임이 없는 칸은 NaN) */
function profile(f: VideoFrames, t0: number, bins: number, bin: number): Float64Array {
  const out = new Float64Array(bins).fill(NaN)
  let i = bisectLeft(f.t, t0, f.n)
  for (let b = 0; b < bins; b++) {
    const until = t0 + (b + 1) * bin
    let sum = 0
    let k = 0
    for (; i < f.n && f.t[i] < until; i++) {
      sum += f.y[i]
      k++
    }
    if (k) out[b] = sum / k
  }
  return out
}

/**
 * 고른 Cycle 구간(src, a0~a1)의 밝기 흐름과 가장 비슷하게 겹치는 곳: 대상(dst)의 b0에서 ±SHIFT_S초 안에서 옮긴 초.
 * 칸마다 각자 평균을 뺀 밝기 차이의 평균 + 옮긴 만큼의 값이 가장 작은 곳 (노출 차이는 지운다). 견줄 프레임이 모자라면 0
 */
export function bestShift(src: VideoFrames, a0: number, a1: number, dst: VideoFrames, b0: number): number {
  const bin = Math.max(BIN_S, (a1 - a0) / MAX_BINS)
  const bins = Math.floor((a1 - a0) / bin)
  const k = Math.round(SHIFT_S / bin)
  if (bins < 3 || !src.n || !dst.n) return 0
  const ya = profile(src, a0, bins, bin)
  const yb = profile(dst, b0 - k * bin, bins + 2 * k, bin)
  let ma = 0
  let na = 0
  for (const v of ya) {
    if (Number.isNaN(v)) continue
    ma += v
    na++
  }
  if (na < bins / 2) return 0
  ma /= na
  let best = 0
  let bestCost = Infinity
  for (let s = -k; s <= k; s++) {
    // 이 자리의 평균 (둘 다 있는 칸만)
    let mb = 0
    let n = 0
    for (let i = 0; i < bins; i++) {
      const v = yb[i + k + s]
      if (Number.isNaN(ya[i]) || Number.isNaN(v)) continue
      mb += v
      n++
    }
    if (n < bins / 2) continue
    mb /= n
    let cost = 0
    for (let i = 0; i < bins; i++) {
      const v = yb[i + k + s]
      if (Number.isNaN(ya[i]) || Number.isNaN(v)) continue
      cost += Math.abs(ya[i] - ma - (v - mb))
    }
    cost = cost / n + SHIFT_PENALTY * Math.abs(s * bin)
    if (cost < bestCost) {
      bestCost = cost
      best = s
    }
  }
  return pyRound(best * bin, 2)
}

/**
 * 메모 구간마다 놓인 자리: 고른 Cycle은 그대로, 모든 Cycle이면 다른 Cycle의 같은 시작 스텝 → 그 뒤 처음 나오는 같은 끝 스텝에서 같은 오프셋,
 * 그리고 밝기 흐름으로 맞춘다 (프레임이 아직 없으면 스텝 자리 그대로). 시작·끝이 다른 영상에 걸치면 그 Cycle은 뺀다.
 * rows: 시각이 있는 Result 행 (시각순) · position: 행의 영상 위치 · frames: 영상마다 잰 프레임
 */
export function placeMemos(
  memos: MemoSpan[],
  rows: ResultRow[],
  position: (row: ResultRow) => { video: number; seconds: number } | null,
  frames: (VideoFrames | undefined)[],
): MemoPlace[] {
  if (!memos.length) return []
  const keys = stepKeys(rows)
  const order = new Map(rows.map((r, i) => [r.index, i]))
  const out: MemoPlace[] = []
  for (const m of memos) {
    const si = order.get(m.start)
    const ei = order.get(m.end)
    if (si === undefined || ei === undefined || ei < si) continue
    const spanOf = (a: number, b: number) => {
      const ps = position(rows[a])
      const pe = position(rows[b])
      if (!ps || !pe || ps.video !== pe.video) return null
      const start = ps.seconds + m.from
      const end = pe.seconds + m.to
      return end > start ? { video: ps.video, start, end } : null
    }
    const src = spanOf(si, ei)
    if (!src) continue
    const cycle = rows[si].cycle
    out.push({ id: m.id, memo: m.memo, cycle, source: true, video: src.video, start: pyRound(src.start, 2), end: pyRound(src.end, 2), shift: 0 })
    if (!m.everyCycle) continue
    const startKey = keys.get(m.start)
    const endKey = keys.get(m.end)
    // 다른 Cycle마다: 같은 시작 스텝 → 그 뒤 처음 나오는 같은 끝 스텝
    const open = new Map<string, number>()
    rows.forEach((r, i) => {
      if (r.cycle === cycle || !r.cycle) return
      const key = keys.get(r.index)
      if (key === startKey && !open.has(r.cycle)) open.set(r.cycle, i)
      const from = open.get(r.cycle)
      if (key !== endKey || from === undefined || from < 0) return
      open.set(r.cycle, -1)
      const at = spanOf(from, i)
      if (!at) return
      const fa = frames[src.video]
      const fb = frames[at.video]
      const shift = fa?.n && fb?.n ? bestShift(fa, src.start, src.end, fb, at.start) : 0
      out.push({
        id: m.id, memo: m.memo, cycle: r.cycle, source: false, video: at.video,
        start: pyRound(at.start + shift, 2), end: pyRound(at.end + shift, 2), shift,
      })
    })
  }
  return out
}

/** 구간 [a, b] 안에 든 부분 (없으면 null) */
const clip = (s: number, e: number, a: number, b: number): [number, number] | null => {
  const x = Math.max(s, a)
  const y = Math.min(e, b)
  return y > x ? [x, y] : null
}

/** 메모 구간 안 검출 하나 (구간 시작부터 초) */
interface Rel {
  kind: DetectedSegment['kind']
  a: number
  d: number
}

export interface MemoTolerance {
  /** 꺼짐·정지 짝: 구간 시작부터 같은 자리 (초) */
  tolS: number
  /** 꺼짐 길이: 이만큼(초) 넘게, 그리고 이 비율(%) 넘게 다르면 다른 꺼짐 */
  durAbsS: number
  durPct: number
}

/**
 * 메모 구간에서 고른 Cycle에 있던 것과 같은 검출을 뺀다 (results: 영상마다 제외 구간을 뺀 검출).
 * 꺼짐·정지 구간은 구간 안에 든 부분을 같은 종류·같은 자리(±tolS)·비슷한 길이의 고른 Cycle 검출과 짝지어, 짝이 있으면 그 부분만 빼고
 * (밖으로 남는 부분이 가장 짧은 길이 — 검은 화면 0.3초 · 정지 기준 — 보다 짧으면 버림, 깜박임은 통째로), 화면 전환은 고른 Cycle에도
 * 같은 자리(±0.5초)에 있으면 뺀다. removed: 메모 id → 뺀 검출 수 (잘려서 남은 것은 세지 않음)
 */
export function applyMemos<R extends DetectResult | undefined>(results: R[], places: MemoPlace[], staticS: number, tol: MemoTolerance) {
  const removed = new Map<string, number>()
  if (!places.length) return { results, removed, total: 0 }
  const count = (id: string) => removed.set(id, (removed.get(id) ?? 0) + 1)
  // 메모마다 고른 Cycle 구간 안 검출 (구간 시작부터)
  const sources = new Map<string, { segs: Rel[]; trans: number[] }>()
  for (const p of places) {
    if (!p.source) continue
    const r = results[p.video]
    const segs: Rel[] = []
    for (const s of r?.segments ?? []) {
      const c = clip(s.start, s.end, p.start, p.end)
      if (c) segs.push({ kind: s.kind, a: c[0] - p.start, d: c[1] - c[0] })
    }
    const trans = (r?.transitions ?? []).filter((t) => t >= p.start && t <= p.end).map((t) => t - p.start)
    sources.set(p.id, { segs, trans })
  }
  const byVideo = new Map<number, MemoPlace[]>()
  for (const p of places) if (sources.has(p.id)) byVideo.set(p.video, [...(byVideo.get(p.video) ?? []), p])
  const out = results.map((r, video) => {
    const list = byVideo.get(video)
    if (!r || !list) return r
    // 검출마다: 짝이 있는 메모 구간들 (그 부분을 뺀다)
    const segments: DetectedSegment[] = []
    for (const seg of r.segments) {
      const cut: [number, number, string][] = []
      for (const p of list) {
        const c = clip(seg.start, seg.end, p.start, p.end)
        if (!c) continue
        const a = c[0] - p.start
        const d = c[1] - c[0]
        const same = sources.get(p.id)!.segs.some((g) => g.kind === seg.kind && Math.abs(g.a - a) <= tol.tolS
          && (seg.kind === 'static' || Math.abs(g.d - d) <= Math.max(tol.durAbsS, (tol.durPct / 100) * g.d)))
        if (same) cut.push([p.start, p.end, p.id])
      }
      if (!cut.length) {
        segments.push(seg)
        continue
      }
      if (seg.kind === 'flicker') {
        count(cut[0][2])
        continue
      }
      // 메모 구간 밖으로 남는 부분
      cut.sort((x, y) => x[0] - y[0])
      const parts: [number, number][] = []
      let from = seg.start
      for (const [a, b] of cut) {
        if (a > from) parts.push([from, Math.min(a, seg.end)])
        from = Math.max(from, b)
      }
      if (from < seg.end) parts.push([from, seg.end])
      const min = seg.kind === 'static' ? staticS : MIN_BLACK_S
      const kept = parts.filter(([a, b]) => b - a >= min)
      if (!kept.length) count(cut[0][2])
      for (const [a, b] of kept) {
        const dur = pyRound(b - a, 2)
        segments.push({ ...seg, start: pyRound(a, 2), end: pyRound(b, 2), dur, info: seg.info.type === 'static' ? { ...seg.info, seconds: dur } : seg.info })
      }
    }
    const transitions: number[] = []
    for (const t of r.transitions) {
      const p = list.find((x) => t >= x.start && t <= x.end && sources.get(x.id)!.trans.some((g) => Math.abs(g - (t - x.start)) <= TRANSITION_TOL_S))
      if (p) count(p.id)
      else transitions.push(t)
    }
    return { ...r, segments, transitions, nTransitions: r.nTransitions - (r.transitions.length - transitions.length) } as R
  })
  let total = 0
  for (const n of removed.values()) total += n
  return { results: out, removed, total }
}
