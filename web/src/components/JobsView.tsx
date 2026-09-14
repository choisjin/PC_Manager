import { useEffect, useMemo, useState } from 'react'
import type { JobRunDetail } from '../api'
import { formatTime } from '../format'
import type { useDashboard } from '../useDashboard'
import { JobDetail } from './JobDetail'
import { JobForm } from './JobForm'
import { StateBadge } from './StateBadge'

interface Props {
  dashboard: ReturnType<typeof useDashboard>
  selectedAgentIds: ReadonlySet<string>
}

export function JobsView({ dashboard, selectedAgentIds }: Props) {
  const { agents, jobs, jobTargets, runs, watchRun, upsertRuns, upsertJobs, upsertTargets, loadJob, subscribeTransfers } =
    dashboard
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null

  useEffect(() => {
    if (selectedJobId) loadJob(selectedJobId).catch(console.error)
  }, [selectedJobId, loadJob])

  const handleCreated = (detail: JobRunDetail) => {
    upsertJobs([detail.job])
    upsertTargets(detail.job.id, detail.targets, true)
    setSelectedJobId(detail.job.id)
    setCreating(false)
  }

  return (
    <div className="jobs-layout">
      <section className="panel job-list">
        <div className="panel-head">
          <h2>Job 기록</h2>
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            + 새 Job
          </button>
        </div>
        <ul>
          {jobs.length === 0 && <li className="placeholder">실행한 Job이 없습니다</li>}
          {jobs.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                className={`job-item${job.id === selectedJobId && !creating ? ' selected' : ''}`}
                onClick={() => {
                  setSelectedJobId(job.id)
                  setCreating(false)
                }}
              >
                <span className="job-item-top">
                  <StateBadge state={job.state} />
                  <span className="job-name ellipsis">{job.name}</span>
                </span>
                <span className="muted small">
                  {formatTime(job.createdAt)} · 단계 {job.steps.length}개
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {creating || !selectedJob ? (
        <JobForm agents={agents} selectedAgentIds={selectedAgentIds} onCreated={handleCreated} />
      ) : (
        <JobDetail
          key={selectedJob.id}
          job={selectedJob}
          targets={jobTargets[selectedJob.id] ?? []}
          agentById={agentById}
          runs={runs}
          watchRun={watchRun}
          upsertRuns={upsertRuns}
          subscribeTransfers={subscribeTransfers}
        />
      )}
    </div>
  )
}
