import { useState } from 'react'
import { FileExplorer } from './components/FileExplorer'
import { type Identity, SelectGate } from './components/SelectGate'
import { SettingsModal } from './components/SettingsModal'
import { UpdateDialog } from './components/UpdateDialog'
import { useDashboard } from './useDashboard'

function cmpVersion(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

const IDENTITY_KEY = 'pcm.identity'

function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    return raw ? (JSON.parse(raw) as Identity) : null
  } catch {
    return null
  }
}

export default function App() {
  const dashboard = useDashboard()
  const {
    agents,
    connected,
    updateStatus,
    pcGroups,
    saveGroups,
    favorites,
    setAgentFavorites,
    shares,
    addShare,
    removeShare,
    org,
    orgActions,
    presence,
    announcePresence,
    watchRun,
    subscribeTransfers,
  } = dashboard

  const [identity, setIdentity] = useState<Identity | null>(() => loadIdentity())
  const [showUpdate, setShowUpdate] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showGate, setShowGate] = useState(false)

  const outdatedAgentCount = updateStatus
    ? agents.filter((a) => a.online && cmpVersion(a.agentVersion, updateStatus.currentVersion) < 0).length
    : 0
  const updateAvailable = (updateStatus?.updateAvailable ?? false) || outdatedAgentCount > 0

  const confirmIdentity = (next: Identity) => {
    setIdentity(next)
    try {
      localStorage.setItem(IDENTITY_KEY, JSON.stringify(next))
    } catch {
      // 무시
    }
    setShowGate(false)
  }

  const project = identity?.projectId ? org.projects.find((p) => p.id === identity.projectId) : null
  const selfUser = identity?.userId ? org.users.find((u) => u.id === identity.userId) : null

  // 아직 신원을 고르지 않았거나, 변경 요청 시 게이트 표시
  if (!identity || showGate) {
    return (
      <>
        <SelectGate org={org} onConfirm={confirmIdentity} onOpenSettings={() => setShowSettings(true)} />
        {showSettings && <SettingsModal org={org} actions={orgActions} onClose={() => setShowSettings(false)} />}
      </>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>PC Manager</h1>
        <span className="topbar-right">
          <button type="button" className="identity-chip" onClick={() => setShowGate(true)} title="프로젝트·사용자 변경">
            <span className="identity-project">{project?.name ?? '전체 보기'}</span>
            {selfUser && <span className="identity-user">· {selfUser.name}</span>}
          </button>
          <button type="button" className="icon gear-btn" title="설정 (프로젝트·사용자 관리)" onClick={() => setShowSettings(true)}>
            ⚙
          </button>
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
      {showSettings && <SettingsModal org={org} actions={orgActions} onClose={() => setShowSettings(false)} />}

      <main className="layout full">
        <FileExplorer
          agents={agents}
          pcGroups={pcGroups}
          saveGroups={saveGroups}
          favorites={favorites}
          setAgentFavorites={setAgentFavorites}
          shares={shares}
          addShare={addShare}
          removeShare={removeShare}
          org={org}
          setAgentProject={orgActions.setAgentProject}
          presence={presence}
          filterProjectId={identity.projectId}
          selfUserId={identity.userId}
          announcePresence={announcePresence}
          subscribeTransfers={subscribeTransfers}
          watchRun={watchRun}
        />
      </main>
    </div>
  )
}
