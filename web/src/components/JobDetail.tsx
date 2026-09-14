import { useEffect, useMemo, useState } from 'react'
import { api, isActiveJob, type Agent, type Artifact, type JobRun, type JobTarget, type Run, type Transfer } from '../api'
import { formatBytes, formatDuration, formatTime } from '../format'
import type { SubscribeTransfers, WatchRun } from '../useDashboard'
import { RunOutput } from './RunOutput'
import { StateBadge } from './StateBadge'

interface Props {
  job: JobRun
  targets: JobTarget[]
  agentById: ReadonlyMap<string, Agent>
  runs: Run[]
  watchRun: WatchRun
  upsertRuns: (runs: Run[]) => void
  subscribeTransfers: SubscribeTransfers
}

export function JobDetail({ job, targets, agentById, runs, watchRun, upsertRuns, subscribeTransfers }: Props) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [cancelling, setCancelling] = useState(false)

  // 명령 실행 기록, 결과 파일, 전송 기록을 불러오고 전송이 끝날 때마다 결과 파일을 갱신한다
  useEffect(() => {
    let active = true
    api
      .jobRuns(job.id)
      .then((list) => active && upsertRuns(list))
      .catch(console.error)

    const loadFiles = () =>
      Promise.all([api.artifacts({ jobRunId: job.id }), api.transfers({ jobRunId: job.id })])
        .then(([artifactList, transferList]) => {
          if (!active) return
          setArtifacts(artifactList)
          setTransfers(transferList)
        })
        .catch(console.error)
    void loadFiles()

    const unsubscribe = subscribeTransfers((transfer) => {
      if (transfer.jobRunId !== job.id) return
      setTransfers((prev) => [transfer, ...prev.filter((t) => t.id !== transfer.id)])
      if (transfer.state !== 'Pending') void loadFiles()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [job.id, upsertRuns, subscribeTransfers])

  const agentId = selectedAgentId ?? targets[0]?.agentId ?? null
  const target = targets.find((t) => t.agentId === agentId)
  const targetRuns = useMemo(
    () => runs.filter((r) => r.jobRunId === job.id && r.agentId === agentId),
    [runs, job.id, agentId],
  )
  const targetArtifacts = artifacts.filter((a) => a.agentId === agentId)
  // 직접 고르지 않았으면 가장 마지막 단계의 출력을 보여준다
  const shownRun =
    targetRuns.find((r) => r.id === selectedRunId) ??
    [...targetRuns].sort((a, b) => (b.stepIndex ?? 0) - (a.stepIndex ?? 0))[0] ??
    null

  const counts = {
    succeeded: targets.filter((t) => t.state === 'Succeeded').length,
    failed: targets.filter((t) => t.state === 'Failed').length,
    active: targets.filter((t) => isActiveJob(t.state)).length,
  }

  const machineName = (id: string) => agentById.get(id)?.machineName ?? id.slice(0, 8)

  const cancel = async () => {
    setCancelling(true)
    try {
      await api.cancelJob(job.id)
    } catch (err) {
      console.error(err)
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="job-detail">
      <section className="panel job-summary">
        <div className="panel-head">
          <div className="output-title">
            <StateBadge state={job.state} />
            <h2 className="ellipsis">{job.name}</h2>
            <span className="muted small">
              {formatTime(job.createdAt)} · 단계 {job.steps.length}개 · 동시 {job.maxParallel || '제한 없음'}
            </span>
          </div>
          <div className="output-actions">
            <span className="muted">
              성공 {counts.succeeded} · 실패 {counts.failed} · 진행 {counts.active} / {targets.length}대
            </span>
            {isActiveJob(job.state) && (
              <button type="button" className="danger" disabled={cancelling} onClick={() => void cancel()}>
                {cancelling ? '취소 요청 중…' : 'Job 취소'}
              </button>
            )}
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <colgroup>
              <col style={{ width: 150 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 70 }} />
              <col style={{ width: 200 }} />
              <col style={{ width: 90 }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>PC</th>
                <th>상태</th>
                <th>단계</th>
                <th>테스트</th>
                <th>소요</th>
                <th>오류</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr
                  key={t.agentId}
                  className={t.agentId === agentId ? 'selected' : ''}
                  onClick={() => {
                    setSelectedAgentId(t.agentId)
                    setSelectedRunId(null)
                  }}
                >
                  <td className="ellipsis">{machineName(t.agentId)}</td>
                  <td>
                    <StateBadge state={t.state} />
                  </td>
                  <td className="mono">{t.currentStep < 0 ? '-' : `${t.currentStep + 1}/${job.steps.length}`}</td>
                  <td>
                    {t.testsTotal === null ? (
                      <span className="muted">-</span>
                    ) : (
                      <span className="tests">
                        {t.testsTotal - (t.testsFailed ?? 0) - (t.testsSkipped ?? 0)} 통과 ·{' '}
                        <b className={t.testsFailed ? 'fail' : ''}>{t.testsFailed ?? 0} 실패</b> · {t.testsSkipped ?? 0} 건너뜀
                      </span>
                    )}
                  </td>
                  <td>
                    {t.startedAt && t.finishedAt
                      ? formatDuration(Date.parse(t.finishedAt) - Date.parse(t.startedAt))
                      : t.startedAt
                        ? '진행 중'
                        : '-'}
                  </td>
                  <td className="ellipsis error-cell" title={t.error ?? undefined}>
                    {t.error ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {target && (
        <ol className="step-chips" aria-label={`${machineName(target.agentId)} 단계`}>
          {job.steps.map((step, index) => {
            const run = step.kind === 'Command' ? targetRuns.find((r) => r.stepIndex === index) : undefined
            const transfer =
              step.kind === 'Collect'
                ? transfers.find((t) => t.agentId === agentId && t.stepIndex === index)
                : undefined
            const label = step.name || (step.kind === 'Collect' ? '결과 수집' : '명령 실행')
            const waiting = isActiveJob(target.state) && index > target.currentStep
            return (
              <li key={index}>
                <button
                  type="button"
                  className={`step-chip${run && run.id === shownRun?.id ? ' active' : ''}`}
                  disabled={!run}
                  title={run ? '출력 보기' : undefined}
                  onClick={() => run && setSelectedRunId(run.id)}
                >
                  <span className="step-no">{index + 1}</span>
                  {label}
                  {run ? (
                    <StateBadge state={run.state} />
                  ) : transfer ? (
                    <>
                      <StateBadge state={transfer.state} />
                      {transfer.state !== 'Pending' && <span className="muted small">{transfer.fileCount}개</span>}
                    </>
                  ) : (
                    <span className="muted small">{waiting ? '대기' : '실행 안 함'}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ol>
      )}

      <div className="job-bottom">
        {shownRun ? (
          <RunOutput key={shownRun.id} run={shownRun} agent={agentById.get(shownRun.agentId)} watchRun={watchRun} />
        ) : (
          <div className="panel empty">명령 단계의 출력이 여기에 표시됩니다</div>
        )}

        <section className="panel artifacts">
          <div className="panel-head">
            <h2>결과 파일</h2>
            <span className="muted small">
              {agentId ? machineName(agentId) : '-'} · {targetArtifacts.length}개
            </span>
          </div>
          <ul className="artifact-list">
            {targetArtifacts.length === 0 && <li className="placeholder">수집된 결과 파일이 없습니다</li>}
            {targetArtifacts.map((artifact) => (
              <li key={artifact.id} className="artifact">
                <span className="artifact-main">
                  <span className="mono ellipsis" title={artifact.relativePath}>
                    {artifact.relativePath}
                  </span>
                  <span className="muted small">
                    {formatBytes(artifact.size)}
                    {artifact.testsTotal !== null &&
                      ` · JUnit ${artifact.testsTotal}건 (실패 ${artifact.testsFailed}, 건너뜀 ${artifact.testsSkipped})`}
                  </span>
                </span>
                <span className="artifact-actions">
                  <a href={api.artifactUrl(artifact.id, true)} target="_blank" rel="noreferrer">
                    보기
                  </a>
                  <a href={api.artifactUrl(artifact.id)} download>
                    다운로드
                  </a>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
