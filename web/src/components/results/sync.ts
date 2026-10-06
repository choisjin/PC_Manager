// 결과 확인 도구: Result 행 시각 ↔ 영상 위치(초) 맞추기
//
//   영상 위치 = (행 시각 − 영상 시작 시각) × 배율 + 보정(초)       (절대 시각 Result)
//   영상 위치 = 행 경과 시간 × 배율 + 보정(초)                    (경과 시간 Result)
//
// 영상 시작 시각은 자동으로 찾고(메타 파일 → 파일 이름 → 수정 시각−길이 → Result 첫 행), 사람이 고칠 수 있다.
// 보정·배율은 '이 장면 = 이 스텝' 기준점으로 계산한다: 1개면 보정만, 2개면 배율까지(시계 속도 차이)
import { parseTime, timeFromName, type ResultRow } from './resultCsv'

export type StartSource = 'manual' | 'meta' | 'name' | 'mtime' | 'result' | 'none'

export const START_SOURCE_LABEL: Record<StartSource, string> = {
  manual: '직접 입력',
  meta: '메타 파일(.meta.json)',
  name: '파일 이름의 시각',
  mtime: '파일 수정 시각 − 영상 길이',
  result: 'Result 첫 행 (추정)',
  none: '모름',
}

export interface VideoInfo {
  path: string
  name: string
  /** 영상 0초의 벽시계 ms */
  start: number | null
  startSource: StartSource
  /** 초 (메타데이터를 읽은 뒤) */
  duration: number | null
  /** 파일 수정 시각 (벽시계 ms) */
  modified: number | null
}

export interface Anchor {
  /** Result 행 번호 (ResultRow.index) */
  row: number
  video: string
  /** 그 장면의 영상 위치(초) */
  videoTime: number
}

export interface SyncState {
  offset: number
  rate: number
  anchors: Anchor[]
  /** 직접 입력한 영상 시작 시각 (경로 → 벽시계 ms) */
  manualStarts: Record<string, number>
}

export const emptySync = (): SyncState => ({ offset: 0, rate: 1, anchors: [], manualStarts: {} })

/** ISO(UTC) 수정 시각 → 지역 벽시계 ms */
export function wallFromIso(iso: string | null): number | null {
  if (!iso) return null
  const utc = Date.parse(iso)
  return Number.isFinite(utc) ? utc - new Date(utc).getTimezoneOffset() * 60_000 : null
}

/** 영상 시작 시각을 자동으로 정한다 (직접 입력이 있으면 그것). meta: .meta.json의 started_at */
export function resolveStart(
  video: Pick<VideoInfo, 'path' | 'name' | 'duration' | 'modified'>,
  metaStarted: string | null,
  manual: number | undefined,
  firstRowTime: number | null,
): { start: number | null; source: StartSource } {
  if (manual !== undefined) return { start: manual, source: 'manual' }
  const meta = metaStarted ? parseTime(metaStarted) : null
  if (meta?.kind === 'absolute') return { start: meta.ms, source: 'meta' }
  const named = timeFromName(video.name)
  if (named !== null) return { start: named, source: 'name' }
  if (video.modified !== null && video.duration) return { start: video.modified - video.duration * 1000, source: 'mtime' }
  if (firstRowTime !== null) return { start: firstRowTime, source: 'result' }
  return { start: null, source: 'none' }
}

/** 보정 전 위치(초): 절대 시각이면 영상 시작부터, 경과 시간이면 그대로 */
export function baseSeconds(rowTime: number, video: VideoInfo | null, absolute: boolean): number | null {
  if (!absolute) return rowTime / 1000
  if (!video || video.start === null) return null
  return (rowTime - video.start) / 1000
}

export function toVideoTime(base: number, sync: SyncState): number {
  return base * sync.rate + sync.offset
}

/** 영상 위치 → 행 시각 (역변환) */
export function toRowTime(videoTime: number, video: VideoInfo | null, absolute: boolean, sync: SyncState): number | null {
  const base = (videoTime - sync.offset) / sync.rate
  if (!absolute) return base * 1000
  if (!video || video.start === null) return null
  return video.start + base * 1000
}

/** 행이 들어 있는 영상: 시작~끝 안에 드는 것, 없으면 가장 가까운 것 (경과 시간이면 지금 영상) */
export function videoForRow(row: ResultRow, videos: VideoInfo[], current: VideoInfo | null, absolute: boolean): VideoInfo | null {
  if (!absolute || row.time === null) return current ?? videos[0] ?? null
  let best: VideoInfo | null = null
  let bestGap = Infinity
  for (const v of videos) {
    if (v.start === null) continue
    const end = v.start + (v.duration ?? 0) * 1000
    const gap = row.time < v.start ? v.start - row.time : row.time > end ? row.time - end : 0
    if (gap < bestGap || (gap === 0 && v === current)) {
      best = v
      bestGap = gap
    }
  }
  return best ?? current ?? videos[0] ?? null
}

/**
 * 기준점으로 보정·배율 계산. 기준점의 보정 전 위치를 base라 하면
 *  1개: offset = videoTime − base (배율 1)
 *  2개 이상: 처음·마지막 두 점을 잇는 직선 (배율 = Δ영상 / Δbase)
 */
export function solveAnchors(anchors: Anchor[], baseOf: (a: Anchor) => number | null): Pick<SyncState, 'offset' | 'rate'> {
  const points = anchors
    .map((a) => ({ base: baseOf(a), video: a.videoTime }))
    .filter((p): p is { base: number; video: number } => p.base !== null)
    .sort((a, b) => a.base - b.base)
  if (points.length === 0) return { offset: 0, rate: 1 }
  if (points.length === 1 || Math.abs(points[points.length - 1].base - points[0].base) < 0.5)
    return { offset: points[0].video - points[0].base, rate: 1 }
  const first = points[0]
  const last = points[points.length - 1]
  const rate = (last.video - first.video) / (last.base - first.base)
  return { offset: first.video - first.base * rate, rate }
}

/** 시각순 정렬된 행 목록에서 t 이하인 마지막 행 (지금 재생 중인 스텝) */
export function rowAtTime(sorted: ResultRow[], t: number): ResultRow | null {
  let lo = 0
  let hi = sorted.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((sorted[mid].time ?? -Infinity) <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found >= 0 ? sorted[found] : null
}
