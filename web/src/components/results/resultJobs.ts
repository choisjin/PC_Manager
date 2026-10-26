// 결과 확인 작업(영상 분석·이미지 찾기) 목록: 서버가 진행을 물어 대시보드 Hub로 알린다 (ResultJobsChanged).
// 결과 확인 탭을 닫거나 새로 고쳐도 테스트 PC에서 계속 돌고, 다시 열면 sourceKey로 찾아 이어 받는다
import { useSyncExternalStore } from 'react'
import { api, type ResultJob, type ResultSchedule } from '../../api'
import { currentSessions, openViewer, type Source } from './resultSessions'
import { openResultTab, type ResultTabRequest } from './resultTab'

export const JOB_KIND_LABEL: Record<ResultJob['kind'], string> = { analysis: '영상 분석', search: '이미지 찾기' }

export const JOB_STATE_LABEL: Record<ResultJob['state'], string> = {
  running: '진행 중', done: '완료', canceled: '멈춤', failed: '실패', lost: '사라짐',
}

const NONE: ResultJob[] = []
// 서버에서 받기 전이면 null (받은 뒤 새로 생긴 것·끝난 것만 알리게)
let jobs: ResultJob[] | null = null
const listeners = new Set<() => void>()

export function setResultJobs(next: ResultJob[]) {
  jobs = next
  listeners.forEach((l) => l())
}

export const resultJobsLoaded = () => jobs !== null

export const reloadResultJobs = () => api.resultJobs().then(setResultJobs, () => {})

/** 새로 시작한 것부터 */
export function useResultJobs(): ResultJob[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => jobs ?? NONE,
  )
}

/** 어느 결과의 작업인지: PC · Result 파일 (영상은 예약 분석이 그 뒤 저장된 것까지 모아 달라질 수 있어 넣지 않는다) */
export const sourceKeyOf = (s: Source) => `${s.agentId}|${s.resultPath}`

/** 이 결과의 가장 최근 작업 (목록을 아직 못 받았으면 서버에 묻는다) */
export async function findJob(sourceKey: string, kind: ResultJob['kind']): Promise<ResultJob | null> {
  const list = jobs ?? (await api.resultJobs().catch(() => NONE))
  return list.find((j) => j.sourceKey === sourceKey && j.kind === kind) ?? null
}

/** 끝난 작업을 봤다고 적는다 (PC 목록의 '분석 완료'를 지움) */
export function markSeen(job: ResultJob | null | undefined) {
  if (job && job.state !== 'running' && !job.seen) void api.markResultJobSeen(job.id).catch(() => {})
}

// 펼쳐 달라는 패널: 결과 확인 화면(Viewer)이 자기 결과면 받아 연다
let panelRequest: { sourceKey: string; kind: ResultJob['kind'] } | null = null
const panelListeners = new Set<() => void>()

export function requestPanel(sourceKey: string, kind: ResultJob['kind']) {
  panelRequest = { sourceKey, kind }
  panelListeners.forEach((l) => l())
}

/** 이 결과에 온 패널 요청을 꺼낸다 (없으면 null) */
export function takePanelRequest(sourceKey: string): ResultJob['kind'] | null {
  if (panelRequest?.sourceKey !== sourceKey) return null
  const kind = panelRequest.kind
  panelRequest = null
  return kind
}

export function subscribePanelRequest(listener: () => void) {
  panelListeners.add(listener)
  return () => {
    panelListeners.delete(listener)
  }
}

/**
 * 작업의 결과를 연다: 이 탭에 그 결과가 있으면 그 화면에서, 없으면 새 결과 확인 탭으로 (그 패널을 펼쳐서).
 * 누른 직후(동기)에 불러야 팝업 차단에 걸리지 않는다. 새 탭을 못 열면 false
 */
export function openJob(job: ResultJob): boolean {
  markSeen(job)
  const session = currentSessions().find((s) => s.state !== 'failed' && sourceKeyOf(s.source) === job.sourceKey)
  if (session) {
    requestPanel(job.sourceKey, job.kind)
    openViewer(session.id)
    return true
  }
  return openResultTab({ ...(job.open as ResultTabRequest), panel: job.kind })
}

// 예약 분석 목록 (시각순): 서버가 ResultSchedulesChanged로 알린다
const NO_SCHEDULES: ResultSchedule[] = []
let schedules: ResultSchedule[] = NO_SCHEDULES
const scheduleListeners = new Set<() => void>()

export function setResultSchedules(next: ResultSchedule[]) {
  schedules = next
  scheduleListeners.forEach((l) => l())
}

export const reloadResultSchedules = () => api.resultSchedules().then(setResultSchedules, () => {})

export function useResultSchedules(): ResultSchedule[] {
  return useSyncExternalStore(
    (l) => {
      scheduleListeners.add(l)
      return () => scheduleListeners.delete(l)
    },
    () => schedules,
  )
}

/** 예약 시각 (짧게: 오늘이면 시각만) */
export function scheduleTimeText(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
