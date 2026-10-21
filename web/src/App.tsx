import { useEffect, useMemo, useState } from 'react'
import { api, type LoginResult, type OrgUser, type Project, setCurrentUser } from './api'
import { FEATURES, type Feature, PermsContext } from './perms'
import { findSelfAgentId } from './selfAgent'
import { FileExplorer } from './components/FileExplorer'
import { useTransfers } from './components/explorer/useTransfers'
import { LoginGate } from './components/LoginGate'
import { GearIcon, UserBox } from './components/UserBox'
import { SettingsPage } from './components/SettingsPage'
import { StatePage } from './components/StatePage'
import { TransfersPage } from './components/TransfersPage'
import { TransfersPip } from './components/TransfersPip'
import { ResultHost } from './components/results/ResultViewer'
import { ResultsPage } from './components/results/ResultsPage'
import { RESULT_TAB_ID } from './components/results/resultTab'
import { RemoteTabHost } from './components/remote/RemoteTabHost'
import { REMOTE_TAB_AGENT } from './components/remote/remoteTab'
import { UpdateDialog } from './components/UpdateDialog'
import { PinDialog } from './components/PinDialog'
import { pcLockStore } from './pcLocks'
import { useDashboard } from './useDashboard'

type Page = 'files' | 'state' | 'results' | 'transfers' | 'settings'

function cmpVersion(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

const IDENTITY_KEY = 'pcm.identity' // 예전 이름 선택 로그인 (지운다)
const TOKEN_KEY = 'pcm.session'
const REMEMBER_KEY = 'pcm.remember'

interface Auth {
  token: string
  user: OrgUser
  project: Project
  perms: string[]
}

const readKey = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writeKey = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // 무시
  }
}

/** 탭 → 그 탭에 필요한 기능 (Setting은 모두: 편집 폴더 같은 내 PC 설정이 있다) */
const PAGE_FEATURE: Record<Page, Feature | null> = { files: 'files', state: 'state', results: 'results', transfers: 'history', settings: null }
const PAGE_ORDER: Page[] = ['files', 'state', 'results', 'transfers', 'settings']
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
    removeAgent,
    reorderShares,
    reloadShares,
    org,
    orgActions,
    presence,
    announcePresence,
    announceUser,
    onlineUsers,
    stateLayout,
    saveStateLayout,
    resultProfiles,
    saveResultProfile,
    pcStatuses,
    setPcStatus,
    serverHostName,
    clientIp,
    remoteUsage,
    chatRooms,
    chatMessages,
    chatActions,
    joinChat,
    subscribeChat,
    subscribeNotes,
    thumbnails,
    watchThumbnails,
    watchRun,
    subscribeTransfers,
    fileFavorites,
    saveFileFavorites,
    reloadFileFavorites,
  } = dashboard

  const [auth, setAuth] = useState<Auth | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [showUpdate, setShowUpdate] = useState(false)
  const [page, setPage] = useState<Page>('files')

  const [ssoError, setSsoError] = useState<string | null>(null)

  // 처음 열 때: APMS 자동 로그인 표 → 남은 세션 → 자동 로그인 토큰 → 로그인 화면
  useEffect(() => {
    writeKey(IDENTITY_KEY, null)
    let cancelled = false
    void (async () => {
      // APMS 가 주소에 붙여 준 1회용 표 (?apmsTicket=…&apmsOrigin=…): 주소에서 지우고 같은 계정으로 로그인
      const params = new URLSearchParams(window.location.search)
      const ticket = params.get('apmsTicket')
      if (ticket) {
        const apmsOrigin = params.get('apmsOrigin') ?? ''
        params.delete('apmsTicket')
        params.delete('apmsOrigin')
        const rest = params.toString()
        window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash)
        try {
          const result = await api.apmsSso(ticket, apmsOrigin)
          writeKey(TOKEN_KEY, result.token)
          if (!cancelled) setAuth(result)
          return
        } catch (err) {
          if (!cancelled) setSsoError('APMS 계정으로 자동 로그인하지 못했습니다: ' + (err instanceof Error ? err.message : String(err)))
        }
      }
      const token = readKey(TOKEN_KEY)
      if (token) {
        try {
          const me = await api.me(token)
          if (!cancelled) setAuth({ token, ...me })
          return
        } catch {
          writeKey(TOKEN_KEY, null)
        }
      }
      const remember = readKey(REMEMBER_KEY)
      if (remember) {
        try {
          const result = await api.autoLogin(remember)
          writeKey(TOKEN_KEY, result.token)
          if (!cancelled) setAuth(result)
        } catch {
          // 만료·폐기면 로그인 화면에서 다시 (서버가 잠깐 꺼졌을 수도 있어 토큰은 남겨 둔다)
        }
      }
    })().finally(() => {
      if (!cancelled) setAuthChecked(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const login = (result: LoginResult) => {
    writeKey(TOKEN_KEY, result.token)
    if (result.remember) writeKey(REMEMBER_KEY, result.remember)
    setAuth(result)
  }
  const logout = () => {
    if (!auth) return
    void api.logout(auth.token, readKey(REMEMBER_KEY)).catch(() => {})
    writeKey(TOKEN_KEY, null)
    writeKey(REMEMBER_KEY, null)
    setAuth(null)
  }

  const userId = auth?.user.id ?? null
  const isAdmin = auth?.user.role === 'admin'
  // 쓸 수 있는 기능: 관리자가 인원 권한을 바꾸면 org 방송으로 바로 반영
  const perms = useMemo<ReadonlySet<string>>(() => {
    if (!auth) return new Set()
    if (isAdmin) return new Set(FEATURES.map((f) => f.id))
    return new Set(org.projectPerms?.[auth.project.id]?.[auth.user.id] ?? auth.perms)
  }, [auth, isAdmin, org.projectPerms])
  const pageAllowed = (p: Page) => {
    const feature = PAGE_FEATURE[p]
    return feature === null || perms.has(feature)
  }
  const visiblePage: Page = pageAllowed(page) ? page : (PAGE_ORDER.find(pageAllowed) ?? 'settings')
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
    setCurrentUser(userId)
    reloadShares()
    reloadFileFavorites()
    // 채팅: 이 사용자의 방만 받는다
    joinChat(userId)
    // 접속 중인 사용자로 알린다 (State 화면)
    announceUser(userId)
  }, [userId, reloadShares, reloadFileFavorites, joinChat, announceUser])

  // id → 이름 해석 (PC/공유, 사용자)
  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of agents) m.set(a.id, a.machineName)
    for (const s of shares) m.set(s.id, s.name)
    return m
  }, [agents, shares])
  const machineName = (id: string) => nameById.get(id) ?? id.slice(0, 8)
  // PIN 창 제목에 쓸 PC 이름 (별칭 우선)
  useEffect(() => {
    pcLockStore.setNameResolver((id) => pcGroups.aliases?.[id]?.trim() || nameById.get(id) || id.slice(0, 8))
  }, [pcGroups, nameById])
  useEffect(() => {
    void pcLockStore.reload()
  }, [])
  const userName = (id: string | null | undefined) => (id ? org.users.find((u) => u.id === id)?.name ?? '(삭제된 사용자)' : null)

  const outdatedAgentCount = updateStatus
    ? agents.filter((a) => a.online && cmpVersion(a.agentVersion, updateStatus.currentVersion) < 0).length
    : 0
  const updateAvailable = (updateStatus?.updateAvailable ?? false) || outdatedAgentCount > 0

  if (!auth) {
    if (!authChecked) return <div className="gate muted">확인 중…</div>
    return <LoginGate org={org} onLogin={login} notice={ssoError} />
  }

  const project = org.projects.find((p) => p.id === auth.project.id) ?? auth.project
  const selfUser = org.users.find((u) => u.id === auth.user.id) ?? auth.user

  // 결과 확인 탭 (?result=…): 대시보드 대신 결과 확인만 (PIN으로 잠긴 PC 파일을 열 때 PIN 창)
  if (RESULT_TAB_ID) {
    return (
      <PermsContext.Provider value={perms}>
        <div className="app">
          <PinDialog />
          <ResultHost machineName={machineName} />
        </div>
      </PermsContext.Provider>
    )
  }

  // 원격조작 탭 (?remote=…): 대시보드 대신 원격조작 창만 (PIN으로 잠긴 PC면 PIN 창)
  if (REMOTE_TAB_AGENT) {
    return (
      <PermsContext.Provider value={perms}>
        <div className="app">
          <PinDialog />
          {perms.has('remote') ? (
            <RemoteTabHost
              initialAgentId={REMOTE_TAB_AGENT}
              agents={agents}
              pcGroups={pcGroups}
              org={org}
              filterProjectId={auth.project.id}
              selfUserId={auth.user.id}
              pcStatuses={pcStatuses}
              remoteUsage={remoteUsage}
              serverHostName={serverHostName}
              clientIp={clientIp}
              selfPc={selfPc}
              selfAgentId={selfAgentOnlineId}
            />
          ) : (
            <div className="gate muted">원격조작 권한이 없습니다.</div>
          )}
        </div>
      </PermsContext.Provider>
    )
  }

  return (
    <PermsContext.Provider value={perms}>
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">R</div>
          <div>
            <h1 className="brand-title">
              <span>RemoteKit</span>
              <span className="brand-proj" title={project.name} translate="no">
                <span className="brand-proj-name">{project.name}</span>
              </span>
            </h1>
            <div className="brand-sub">PC Manager</div>
          </div>
        </div>
        <nav className="tabs" role="tablist">
          {pageAllowed('files') && (
            <button type="button" role="tab" aria-selected={visiblePage === 'files'} className={visiblePage === 'files' ? 'active' : ''} onClick={() => setPage('files')}>
              PC Manager
            </button>
          )}
          {pageAllowed('state') && (
            <button type="button" role="tab" aria-selected={visiblePage === 'state'} className={visiblePage === 'state' ? 'active' : ''} onClick={() => setPage('state')}>
              State
            </button>
          )}
          {pageAllowed('results') && (
            <button type="button" role="tab" aria-selected={visiblePage === 'results'} className={visiblePage === 'results' ? 'active' : ''} onClick={() => setPage('results')} title="결과 확인: PC별 결과 폴더에서 날짜로 불러오기">
              Result
            </button>
          )}
          {pageAllowed('transfers') && (
            <button type="button" role="tab" aria-selected={visiblePage === 'transfers'} className={visiblePage === 'transfers' ? 'active' : ''} onClick={() => setPage('transfers')}>
              History
              {transfers.some((t) => t.state === 'Pending') && <span className="tab-badge">{transfers.filter((t) => t.state === 'Pending').length}</span>}
            </button>
          )}
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
        {/* 설정: 톱니바퀴 */}
        <button
          type="button"
          className={`gear-btn${visiblePage === 'settings' ? ' active' : ''}`}
          title="설정"
          aria-label="설정"
          onClick={() => setPage(visiblePage === 'settings' ? (PAGE_ORDER.find((p) => p !== 'settings' && pageAllowed(p)) ?? 'settings') : 'settings')}
        >
          <GearIcon />
        </button>
        <UserBox user={selfUser} project={project} isAdmin={isAdmin} onLogout={logout} />
      </header>

      {showUpdate && (
        <UpdateDialog status={updateStatus} agents={agents} onClose={() => setShowUpdate(false)} />
      )}

      <main className="layout full">
        {visiblePage === 'files' ? (
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
            removeAgent={removeAgent}
            reorderShares={reorderShares}
            org={org}
            setAgentProject={orgActions.setAgentProject}
            presence={presence}
            filterProjectId={auth.project.id}
            selfUserId={auth.user.id}
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
            fileFavorites={fileFavorites}
            saveFileFavorites={saveFileFavorites}
          />
        ) : visiblePage === 'state' ? (
          <StatePage
            agents={agents}
            pcGroups={pcGroups}
            pcStatuses={pcStatuses}
            remoteUsage={remoteUsage}
            presence={presence}
            transfers={transfers}
            org={org}
            serverHostName={serverHostName}
            selfUserId={auth.user.id}
            onlineUsers={onlineUsers}
            layout={stateLayout}
            saveLayout={saveStateLayout}
            connected={connected}
          />
        ) : visiblePage === 'results' ? (
          <ResultsPage
            agents={agents}
            pcGroups={pcGroups}
            org={org}
            filterProjectId={auth.project.id}
            selfUserId={auth.user.id}
            profiles={resultProfiles}
            saveProfile={saveResultProfile}
            userName={userName}
          />
        ) : visiblePage === 'settings' ? (
          <SettingsPage
            org={org}
            agents={agents}
            pcGroups={pcGroups}
            selfAgentId={selfAgentOnlineId}
            token={auth.token}
            projectId={auth.project.id}
            isAdmin={isAdmin}
            noPerms={!isAdmin && perms.size === 0}
          />
        ) : (
          <TransfersPage transfers={transfers} artifactByTransfer={artifactByTransfer} machineName={machineName} userName={userName} />
        )}
      </main>

      {/* 잠긴 PC를 열 때 PIN 입력 */}
      <PinDialog />

      {/* 결과 확인: 경로 지정 창 · 불러온 결과의 전체 화면 · 준비 완료 알림 */}
      <ResultHost machineName={machineName} />

      {/* 어디서든 보이는 전송 진행률·알림 위젯 */}
      <TransfersPip
        transfers={transfers}
        machineName={machineName}
        userName={userName}
        org={org}
        selfUserId={auth.user.id}
        chatRooms={chatRooms}
        chatMessages={chatMessages}
        chatActions={chatActions}
        subscribeChat={subscribeChat}
        subscribeNotes={subscribeNotes}
      />
    </div>
    </PermsContext.Provider>
  )
}
