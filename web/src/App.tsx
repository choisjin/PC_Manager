import { useEffect, useMemo, useState } from 'react'
import { setCurrentUser } from './api'
import { findSelfAgentId } from './selfAgent'
import { FileExplorer } from './components/FileExplorer'
import { useTransfers } from './components/explorer/useTransfers'
import { type Identity, SelectGate } from './components/SelectGate'
import { SettingsModal } from './components/SettingsModal'
import { SettingsPage } from './components/SettingsPage'
import { TransfersPage } from './components/TransfersPage'
import { TransfersPip } from './components/TransfersPip'
import { UpdateDialog } from './components/UpdateDialog'
import { useDashboard } from './useDashboard'

type Page = 'files' | 'transfers' | 'settings'

function cmpVersion(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

const IDENTITY_KEY = 'pcm.identity'
const SELF_PC_KEY = 'pcm.selfPc'

/** 에이전트 런처가 연 대시보드면 주소에 ?pc=<이 PC 이름>이 붙는다. 기억해 두고 주소에서는 지운다 */
function loadSelfPc(): string | null {
  try {
    const url = new URL(window.location.href)
    const fromUrl = url.searchParams.get('pc')
    if (fromUrl) {
      localStorage.setItem(SELF_PC_KEY, fromUrl)
      url.searchParams.delete('pc')
      window.history.replaceState(null, '', url.pathname + url.search + url.hash)
      return fromUrl
    }
    return localStorage.getItem(SELF_PC_KEY)
  } catch {
    return null
  }
}

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
    renameShare,
    reloadShares,
    org,
    orgActions,
    presence,
    announcePresence,
    pcStatuses,
    setPcStatus,
    serverHostName,
    clientIp,
    remoteUsage,
    chat,
    sendChat,
    markChatRead,
    thumbnails,
    watchThumbnails,
    watchRun,
    subscribeTransfers,
  } = dashboard

  const [identity, setIdentity] = useState<Identity | null>(() => loadIdentity())
  const [showUpdate, setShowUpdate] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showGate, setShowGate] = useState(false)
  const [page, setPage] = useState<Page>('files')
  const [selfPc] = useState(loadSelfPc)
  // 대시보드를 연 PC의 에이전트 (온라인일 때만): Setting의 편집 폴더 관리에 쓴다
  const selfAgentOnlineId = useMemo(() => {
    const id = findSelfAgentId(agents, selfPc, clientIp, serverHostName)
    return id && agents.some((a) => a.id === id && a.online) ? id : null
  }, [agents, selfPc, clientIp, serverHostName])

  // 전송 기록/PiP 공용 데이터 (한 번만 구독)
  const { transfers, artifactByTransfer } = useTransfers(subscribeTransfers)

  // 전송 요청 헤더에 현재 사용자 id를 실어 "누가 실행했는지" 기록
  // 공유 폴더는 사용자별이라 사용자가 바뀌면 그 사용자의 목록으로 다시 불러온다
  useEffect(() => {
    setCurrentUser(identity?.userId ?? null)
    reloadShares()
  }, [identity?.userId, reloadShares])

  // id → 이름 해석 (PC/공유, 사용자)
  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of agents) m.set(a.id, a.machineName)
    for (const s of shares) m.set(s.id, s.name)
    return m
  }, [agents, shares])
  const machineName = (id: string) => nameById.get(id) ?? id.slice(0, 8)
  const userName = (id: string | null | undefined) => (id ? org.users.find((u) => u.id === id)?.name ?? '(삭제된 사용자)' : null)

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
        <h1>Don't Move</h1>
        <nav className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={page === 'files'} className={page === 'files' ? 'active' : ''} onClick={() => setPage('files')}>
            PC Manager
          </button>
          <button type="button" role="tab" aria-selected={page === 'transfers'} className={page === 'transfers' ? 'active' : ''} onClick={() => setPage('transfers')}>
            History
            {transfers.some((t) => t.state === 'Pending') && <span className="tab-badge">{transfers.filter((t) => t.state === 'Pending').length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={page === 'settings'} className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
            Setting
          </button>
        </nav>
        <span className="topbar-right">
          <button type="button" className="identity-chip" onClick={() => setShowGate(true)} title="프로젝트·사용자 변경">
            <span className="identity-project">{project?.name ?? '전체 보기'}</span>
            {selfUser && <span className="identity-user">· {selfUser.name}</span>}
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

      <main className="layout full">
        {page === 'files' ? (
          <FileExplorer
            agents={agents}
            pcGroups={pcGroups}
            saveGroups={saveGroups}
            favorites={favorites}
            setAgentFavorites={setAgentFavorites}
            shares={shares}
            addShare={addShare}
            removeShare={removeShare}
            renameShare={renameShare}
            org={org}
            setAgentProject={orgActions.setAgentProject}
            presence={presence}
            filterProjectId={identity.projectId}
            selfUserId={identity.userId}
            pcStatuses={pcStatuses}
            setPcStatus={setPcStatus}
            remoteUsage={remoteUsage}
            setFolderProject={orgActions.setFolderProject}
            thumbnails={thumbnails}
            watchThumbnails={watchThumbnails}
            serverHostName={serverHostName}
            clientIp={clientIp}
            selfPc={selfPc}
            announcePresence={announcePresence}
            subscribeTransfers={subscribeTransfers}
            watchRun={watchRun}
          />
        ) : page === 'settings' ? (
          <SettingsPage org={org} actions={orgActions} agents={agents} pcGroups={pcGroups} selfAgentId={selfAgentOnlineId} />
        ) : (
          <TransfersPage transfers={transfers} artifactByTransfer={artifactByTransfer} machineName={machineName} userName={userName} />
        )}
      </main>

      {/* 어디서든 보이는 전송 진행률·알림 위젯 */}
      <TransfersPip transfers={transfers} machineName={machineName} userName={userName} chat={chat} users={org.users} selfUserId={identity.userId} onSendChat={sendChat} onMarkRead={markChatRead} />
    </div>
  )
}
