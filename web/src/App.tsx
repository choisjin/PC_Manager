import { useMemo, useState } from 'react'
import type { Run } from './api'
import { AgentList } from './components/AgentList'
import { CommandForm } from './components/CommandForm'
import { FileExplorer } from './components/FileExplorer'
import { JobsView } from './components/JobsView'
import { RunOutput } from './components/RunOutput'
import { RunTable } from './components/RunTable'
import { UpdateDialog } from './components/UpdateDialog'
import { useDashboard } from './useDashboard'

type Tab = 'commands' | 'jobs' | 'files'

function cmpVersion(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'commands', label: '명령 실행' },
  { id: 'jobs', label: 'Job' },
  { id: 'files', label: '파일 탐색기' },
]

export default function App() {
  const dashboard = useDashboard()
  const { agents, runs, connected, updateStatus, watchRun, upsertRuns, subscribeTransfers } = dashboard
  const [tab, setTab] = useState<Tab>('commands')
  const [showUpdate, setShowUpdate] = useState(false)
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set())
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [onlySelectedAgents, setOnlySelectedAgents] = useState(false)

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  // Job 단계로 실행된 명령은 Job 탭에서 본다
  const visibleRuns = useMemo(
    () =>
      runs.filter((r) => !r.jobRunId && (!onlySelectedAgents || selectedAgentIds.has(r.agentId))),
    [runs, onlySelectedAgents, selectedAgentIds],
  )
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null

  // 서버 새 버전 또는 서버보다 구버전인 온라인 에이전트가 있으면 업데이트 알림
  const outdatedAgentCount = updateStatus
    ? agents.filter((a) => a.online && cmpVersion(a.agentVersion, updateStatus.currentVersion) < 0).length
    : 0
  const updateAvailable = (updateStatus?.updateAvailable ?? false) || outdatedAgentCount > 0

  const handleCreated = (created: Run[]) => {
    upsertRuns(created)
    if (created.length > 0) setSelectedRunId(created[0].id)
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>PC Manager</h1>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span className="topbar-right">
          <button
            type="button"
            className={`update-chip${updateAvailable ? ' available' : ''}`}
            onClick={() => setShowUpdate(true)}
            title="업데이트 확인"
          >
            {updateAvailable ? '● 업데이트 있음' : `v${updateStatus?.currentVersion ?? '…'}`}
          </button>
          <span className={`conn ${connected ? 'on' : 'off'}`}>
            {connected ? '서버 연결됨' : '서버 연결 중…'}
          </span>
        </span>
      </header>

      {showUpdate && (
        <UpdateDialog status={updateStatus} agents={agents} onClose={() => setShowUpdate(false)} />
      )}

      <main className="layout">
        <AgentList
          agents={agents}
          selectedIds={selectedAgentIds}
          onSelectionChange={setSelectedAgentIds}
        />

        {tab === 'commands' && (
          <section className="workspace">
            <CommandForm agentIds={[...selectedAgentIds]} onCreated={handleCreated} />
            <RunTable
              runs={visibleRuns}
              agentById={agentById}
              selectedRunId={selectedRunId}
              onSelect={setSelectedRunId}
              onlySelectedAgents={onlySelectedAgents}
              onOnlySelectedAgentsChange={setOnlySelectedAgents}
            />
            {selectedRun ? (
              <RunOutput
                key={selectedRun.id}
                run={selectedRun}
                agent={agentById.get(selectedRun.agentId)}
                watchRun={watchRun}
              />
            ) : (
              <div className="panel empty">실행 기록을 선택하면 출력이 여기에 표시됩니다</div>
            )}
          </section>
        )}

        {tab === 'jobs' && <JobsView dashboard={dashboard} selectedAgentIds={selectedAgentIds} />}

        {tab === 'files' && (
          <FileExplorer
            agents={agents}
            selectedAgentIds={selectedAgentIds}
            subscribeTransfers={subscribeTransfers}
          />
        )}
      </main>
    </div>
  )
}
