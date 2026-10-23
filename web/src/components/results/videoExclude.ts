import type { ResultRow } from './resultCsv'
import { type DetectedSegment, type DetectResult, pyRound } from './videoDetect'

// 영상 분석 제외 구간: Result 표에서 고른 시작 스텝 ~ 끝 스텝(끝 스텝이 끝날 때까지)은 검출에서 뺀다
// (종료 명령으로 일부러 끈 화면 등). 모든 Cycle이면 Cycle마다 같은 스텝 사이를 뺀다.
// 판정은 그대로 두고 결과에서만 빼므로 바꾸면 바로 반영된다

/** 제외 구간 하나: 시작·끝 스텝 (ResultRow.index) */
export interface Exclusion {
  id: string
  start: number
  end: number
  /** Cycle마다 같은 스텝(이름과 그 Cycle 안에서 몇 번째 같은 이름인지) 사이를 뺀다 */
  everyCycle: boolean
}

/** 고르는 중인 제외 구간 (표에서 시작·끝 스텝을 고른다, 자르기와 같게) */
export interface ExclusionDraft {
  start: number | null
  end: number | null
  everyCycle: boolean
}

/** 검은 화면이 이보다 짧게 남으면 버린다 (판정의 0.3초 미만 빈 화면과 같게) */
const MIN_BLACK_S = 0.3

/** 행 → Cycle 안에서의 자리 ("이름\0몇 번째"): Cycle마다 같은 스텝을 찾는 열쇠 (rows: 시각순) */
function stepKeys(rows: ResultRow[]): Map<number, string> {
  const seen = new Map<string, number>()
  const keys = new Map<number, string>()
  for (const r of rows) {
    const inCycle = `${r.cycle}\u0000${r.name}`
    const k = seen.get(inCycle) ?? 0
    seen.set(inCycle, k + 1)
    keys.set(r.index, `${r.name}\u0000${k}`)
  }
  return keys
}

/** 스텝이 끝난 시각: 걸린 시간, 없으면 다음 스텝 시작 (자르기와 같은 계산) */
function stepEnd(rows: ResultRow[], i: number): number {
  const r = rows[i]
  if (r.durationMs !== null) return r.time! + r.durationMs
  return rows[i + 1]?.time ?? r.time!
}

/** 제외 구간 하나가 빼는 시각 구간들 [시작, 끝] (Result 행 시각과 같은 ms). rows: 시각이 있는 행, 시각순 */
export function spansOf(ex: Exclusion, rows: ResultRow[]): [number, number][] {
  const order = new Map(rows.map((r, i) => [r.index, i]))
  const si = order.get(ex.start)
  const ei = order.get(ex.end)
  if (si === undefined || ei === undefined || ei < si) return []
  if (!ex.everyCycle) return [[rows[si].time!, stepEnd(rows, ei)]]
  const keys = stepKeys(rows)
  const startKey = keys.get(ex.start)
  const endKey = keys.get(ex.end)
  // Cycle마다 시작 스텝 → 그 뒤 처음 나오는 끝 스텝 (시작과 끝이 같은 스텝이면 그 스텝만)
  const open = new Map<string, number>()
  const out: [number, number][] = []
  rows.forEach((r, i) => {
    const key = keys.get(r.index)
    if (key === startKey && !open.has(r.cycle)) open.set(r.cycle, i)
    const from = open.get(r.cycle)
    if (key === endKey && from !== undefined) {
      out.push([rows[from].time!, stepEnd(rows, i)])
      open.delete(r.cycle)
    }
  })
  return out
}

/** 구간들을 시각순으로, 겹치거나 맞닿으면 합친다 */
export function mergeSpans(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/**
 * 판정 결과에서 제외 구간(영상 안 초, mergeSpans한 것)을 뺀다: 검은 화면·정지 구간은 구간 밖으로 남는 부분만 남기고
 * (가장 짧은 길이 — 검은 화면 0.3초 · 정지 기준 — 보다 짧아지면 버림), 깜박임·화면 전환은 걸치면 버린다.
 * removed: 통째로 뺀 검출 수 (잘려서 남은 것은 세지 않음)
 */
export function applyExclusions(r: DetectResult, spans: [number, number][], staticS: number): { result: DetectResult; removed: number } {
  if (!spans.length) return { result: r, removed: 0 }
  const inside = (t: number) => spans.some(([a, b]) => a <= t && t <= b)
  const segments: DetectedSegment[] = []
  let removed = 0
  for (const seg of r.segments) {
    if (!spans.some(([a, b]) => a < seg.end && seg.start < b)) {
      segments.push(seg)
      continue
    }
    if (seg.kind === 'flicker') {
      removed++
      continue
    }
    // 제외 구간 밖으로 남는 부분
    const parts: [number, number][] = []
    let from = seg.start
    for (const [a, b] of spans) {
      if (b <= from) continue
      if (a >= seg.end) break
      if (a > from) parts.push([from, a])
      from = Math.max(from, b)
      if (from >= seg.end) break
    }
    if (from < seg.end) parts.push([from, seg.end])
    const min = seg.kind === 'static' ? staticS : MIN_BLACK_S
    const kept = parts.filter(([a, b]) => b - a >= min)
    if (!kept.length) removed++
    for (const [a, b] of kept) {
      const dur = pyRound(b - a, 2)
      segments.push({ ...seg, start: pyRound(a, 2), end: pyRound(b, 2), dur, info: seg.info.type === 'static' ? { ...seg.info, seconds: dur } : seg.info })
    }
  }
  const transitions = r.transitions.filter((t) => !inside(t))
  const dropped = r.transitions.length - transitions.length
  return {
    result: { ...r, segments, transitions, nTransitions: r.nTransitions - dropped },
    removed: removed + dropped,
  }
}
