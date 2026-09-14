import type { JobState, RunState, TransferState } from '../api'

type State = RunState | JobState | TransferState

const LABELS: Record<State, string> = {
  Pending: '대기',
  Running: '실행 중',
  Succeeded: '성공',
  Failed: '실패',
  TimedOut: '시간 초과',
  Cancelled: '취소됨',
}

export function StateBadge({ state }: { state: State }) {
  return <span className={`badge ${state}`}>{LABELS[state]}</span>
}
