import { useEffect, useState } from 'react'
import { isActiveRun, type Agent, type Run } from '../api'
import { formatDuration, formatTime } from '../format'
import { StateBadge } from './StateBadge'

interface Props {
  runs: Run[]
  agentById: ReadonlyMap<string, Agent>
  selectedRunId: string | null
  onSelect: (runId: string) => void
  onlySelectedAgents: boolean
  onOnlySelectedAgentsChange: (value: boolean) => void
}

/** 실행 중인 항목이 있을 때만 1초마다 갱신되는 현재 시각 */
function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

export function RunTable({
  runs,
  agentById,
  selectedRunId,
  onSelect,
  onlySelectedAgents,
  onOnlySelectedAgentsChange,
}: Props) {
  const now = useNow(runs.some((r) => r.state === 'Running'))

  return (
    <section className="panel runs">
      <div className="panel-head">
        <h2>실행 기록</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={onlySelectedAgents}
            onChange={(e) => onOnlySelectedAgentsChange(e.target.checked)}
          />
          선택한 PC만
        </label>
      </div>

      <div className="table-wrap">
        <table>
          <colgroup>
            <col style={{ width: 96 }} />
            <col style={{ width: 150 }} />
            <col />
            <col style={{ width: 80 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 96 }} />
          </colgroup>
          <thead>
            <tr>
              <th>상태</th>
              <th>PC</th>
              <th>명령</th>
              <th>종료 코드</th>
              <th>시작</th>
              <th>소요</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={6} className="placeholder">
                  실행 기록이 없습니다
                </td>
              </tr>
            )}
            {runs.map((run) => (
              <tr
                key={run.id}
                className={run.id === selectedRunId ? 'selected' : ''}
                onClick={() => onSelect(run.id)}
              >
                <td>
                  <StateBadge state={run.state} />
                </td>
                <td className="ellipsis">
                  {agentById.get(run.agentId)?.machineName ?? run.agentId.slice(0, 8)}
                </td>
                <td className="mono ellipsis" title={run.commandLine}>
                  {run.commandLine}
                </td>
                <td className="mono">{run.exitCode ?? '-'}</td>
                <td>{formatTime(run.startedAt ?? run.createdAt)}</td>
                <td>
                  {run.startedAt
                    ? formatDuration(
                        (run.finishedAt ? Date.parse(run.finishedAt) : isActiveRun(run.state) ? now : Date.parse(run.startedAt)) -
                          Date.parse(run.startedAt),
                      )
                    : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
