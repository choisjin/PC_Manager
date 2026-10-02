import { useEffect, useMemo, useState } from 'react'
import type { Agent, Org, PcFavorites, PcGroups, PcStatus, PcStatusValue, RemoteUsage, SharedFolder, Thumbnail } from '../api'
import { RemoteGrid, type RemoteSection } from './RemoteGrid'
import { RemoteContext, type RemoteContextValue } from './remote/RemoteContext'
import type { SubscribeTransfers, WatchRun } from '../useDashboard'
import { ExplorerPane, type Pane } from './explorer/ExplorerPane'
import { ExplorerToolbar } from './explorer/ExplorerToolbar'
import { Icon } from './explorer/Icon'
import type { PaneController } from './explorer/paneController'
import { PcTree } from './explorer/PcTree'
import { AGENT_MIME, buildTree, displayName, type FileClipboard, type FolderNode, newId } from './explorer/pcGroups'

interface Props {
  agents: Agent[]
  pcGroups: PcGroups
  saveGroups: (groups: PcGroups) => void
  favorites: PcFavorites
  setAgentFavorites: (agentId: string, paths: string[]) => void
  shares: SharedFolder[]
  addShare: (name: string, path: string, username?: string, password?: string) => Promise<void>
  removeShare: (id: string) => void
  renameShare: (id: string, name: string) => Promise<void>
  org: Org
  setAgentProject: (agentId: string, projectId: string | null) => Promise<void>
  presence: Record<string, string[]>
  pcStatuses: Record<string, PcStatus>
  setPcStatus: (agentId: string, status: PcStatusValue, note: string | null) => Promise<void>
  remoteUsage: RemoteUsage['inUseBy']
  setFolderProject: (folderId: string, projectId: string | null) => Promise<void>
  thumbnails: Record<string, Thumbnail>
  watchThumbnails: (agentIds: string[]) => void
  /** 서버(=대시보드)가 도는 PC의 머신 이름. Remote 모드에서 이 PC는 숨긴다 */
  serverHostName: string | null
  /** 대시보드를 연 이 PC의 IP. 이 IP의 에이전트도 Remote 모드에서 숨긴다 */
  clientIp: string | null
  /** 에이전트 런처가 알려 준 이 PC의 이름 (가장 정확). Remote 모드에서 숨긴다 */
  selfPc: string | null
  filterProjectId: string | null
  selfUserId: string | null
  announcePresence: (userId: string, agentIds: string[]) => void
  subscribeTransfers: SubscribeTransfers
  watchRun: WatchRun
}

// 브라우저별 저장 (열린 창, 열/접힘 상태)
function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 무시
  }
}

const MODE_KEY = 'explorer.mode'
const COLLAPSE_KEY = 'pcm.explorer.collapsed'
const PANES_KEY = 'pcm.explorer.panes'

export function FileExplorer({ agents, pcGroups, saveGroups, favorites, setAgentFavorites, shares, addShare, removeShare, renameShare, org, setAgentProject, presence, pcStatuses, setPcStatus, remoteUsage, setFolderProject, thumbnails, watchThumbnails, serverHostName, clientIp, selfPc, filterProjectId, selfUserId, announcePresence, subscribeTransfers, watchRun }: Props) {
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  // 선택한 프로젝트의 에이전트 + 아직 미배정 에이전트를 노출 (다른 프로젝트 전용은 숨김). 전체 보기면 모두.
  const visibleAgents = useMemo(
    () =>
      filterProjectId
        ? agents.filter((a) => {
            const pid = org.agentProjects[a.id]
            return !pid || pid === filterProjectId
          })
        : agents,
    [agents, org.agentProjects, filterProjectId],
  )
  // Remote 모드에서는 서버 PC와, 지금 대시보드를 보고 있는 이 PC를 숨긴다 (자기 화면을 원격하면 화면이 무한히 겹친다).
  // Browser·파일 작업에는 그대로 둔다
  // 대시보드를 연 PC의 에이전트 ('내 PC 프로그램으로 열기'에 쓴다):
  // 런처가 알려 준 PC 이름 → 접속 IP → 서버 PC에서 localhost로 연 경우 서버 PC
  const selfAgentId = useMemo(() => {
    const byName = (name: string | null) => (name ? agents.find((a) => a.machineName.toLowerCase() === name.toLowerCase()) : undefined)
    const found = byName(selfPc) ?? (clientIp ? agents.find((a) => a.ipAddresses.includes(clientIp)) : byName(serverHostName))
    return found?.id ?? null
  }, [agents, selfPc, clientIp, serverHostName])
  const selfOnline = !!selfAgentId && agents.some((a) => a.id === selfAgentId && a.online)

  const remoteAgents = useMemo(
    () =>
      visibleAgents.filter((a) => {
        if (serverHostName && a.machineName.toLowerCase() === serverHostName.toLowerCase()) return false
        if (selfPc && a.machineName.toLowerCase() === selfPc.toLowerCase()) return false
        if (clientIp && a.ipAddresses.includes(clientIp)) return false
        return true
      }),
    [visibleAgents, serverHostName, clientIp, selfPc],
  )
  const shareById = useMemo(() => new Map(shares.map((s) => [s.id, s])), [shares])
  // 창 제목·온라인 상태: 에이전트면 별칭, 공유 폴더면 공유 이름
  const sourceName = (id: string) => {
    const agent = agentById.get(id)
    if (agent) return displayName(agent, pcGroups)
    const share = shareById.get(id)
    if (share) return share.name
    return id.slice(0, 8)
  }
  const sourceOnline = (id: string) => agentById.get(id)?.online ?? shareById.has(id)

  const addFavorite = (agentId: string, path: string) => {
    const current = favorites.favorites[agentId] ?? []
    if (!current.some((p) => p.toLowerCase() === path.toLowerCase())) setAgentFavorites(agentId, [...current, path])
  }
  const removeFavorite = (agentId: string, path: string) =>
    setAgentFavorites(agentId, (favorites.favorites[agentId] ?? []).filter((p) => p !== path))
  const [collapsed, setCollapsed] = useState(() => loadLocal(COLLAPSE_KEY, false))
  // Browser(파일 탐색기) ↔ Remote(PC 화면 미리보기) 모드
  const [mode, setMode] = useState<'browser' | 'remote'>(() => loadLocal<'browser' | 'remote'>(MODE_KEY, 'browser'))
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const switchMode = (next: 'browser' | 'remote') => {
    setMode(next)
    try {
      localStorage.setItem(MODE_KEY, JSON.stringify(next))
    } catch {
      // 무시
    }
  }
  // Remote 모드 대상: 선택한 폴더(하위 포함), 없으면 전체. 폴더(그룹)별 구역으로 나눠 보여 준다
  // allSections는 선택과 무관한 전체 구역 (원격 창 빠른 전환 목록의 그룹 표시에 쓴다)
  const { remoteTargets, allSections } = useMemo(() => {
    // 트리와 같은 규칙: 다른 프로젝트에 배정된 폴더는 숨긴다
    const folderVisible = (folderId: string) => {
      const pid = org.folderProjects?.[folderId]
      if (!pid) return true
      if (filterProjectId) return pid === filterProjectId
      return selfUserId ? (org.projectUsers[pid] ?? []).includes(selfUserId) : true
    }
    const { roots, ungrouped } = buildTree(pcGroups, remoteAgents)
    const sections: RemoteSection[] = []
    const walk = (n: FolderNode, path: string) => {
      if (!folderVisible(n.folder.id)) return
      if (n.agents.length > 0) sections.push({ key: n.folder.id, name: path, agents: n.agents })
      for (const c of n.children) walk(c, `${path} / ${c.folder.name}`)
    }
    for (const r of roots) walk(r, r.folder.name)
    if (ungrouped.length > 0) sections.push({ key: 'ungrouped', name: '미분류', agents: ungrouped })
    const all = [...sections]
    const whole = { remoteTargets: { name: null as string | null, sections: all }, allSections: all }
    if (!selectedFolderId) return whole
    const find = (nodes: FolderNode[]): FolderNode | null => {
      for (const n of nodes) {
        if (n.folder.id === selectedFolderId) return n
        const c = find(n.children)
        if (c) return c
      }
      return null
    }
    const node = find(roots)
    if (!node) return whole
    sections.length = 0
    walk(node, node.folder.name)
    return { remoteTargets: { name: node.folder.name, sections: [...sections] }, allSections: all }
  }, [selectedFolderId, pcGroups, remoteAgents, org.folderProjects, org.projectUsers, filterProjectId, selfUserId])

  // 원격조작 모달의 PC 목록(빠른 전환): 그룹(폴더) 순서, 그룹 안은 별칭 순
  const remoteContext = useMemo<RemoteContextValue>(
    () => ({
      pcs: allSections.flatMap((section) =>
        section.agents
          .map((a) => ({
            id: a.id,
            name: displayName(a, pcGroups),
            group: section.name,
            online: a.online,
            status: pcStatuses[a.id] ?? null,
            inUseBy: remoteUsage[a.id]?.userId ?? null,
          }))
          .sort((x, y) => x.name.localeCompare(y.name, 'ko', { numeric: true, sensitivity: 'base' })),
      ),
      userName: (id) => org.users.find((u) => u.id === id)?.name ?? '다른 사용자',
    }),
    [allSections, pcGroups, pcStatuses, remoteUsage, org.users],
  )
  const [panes, setPanes] = useState<Pane[]>(() => loadLocal<Pane[]>(PANES_KEY, []))
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null)

  // 지금 열어둔 PC를 서버에 알린다(실시간 프레즌스). 이름을 고른 사용자만.
  const openAgentKey = panes.map((p) => p.agentId).join(',')
  useEffect(() => {
    if (selfUserId) announcePresence(selfUserId, [...new Set(panes.map((p) => p.agentId))])
    // openAgentKey/selfUserId가 바뀔 때만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAgentKey, selfUserId, announcePresence])
  const [dropActive, setDropActive] = useState(false)
  const [activePaneId, setActivePaneId] = useState<string | null>(null)
  const [activeController, setActiveController] = useState<PaneController | null>(null)

  const updatePanes = (next: Pane[]) => {
    setPanes(next)
    saveLocal(PANES_KEY, next)
  }

  // 활성 창만 컨트롤러를 알려온다 → 툴바가 그 창을 조작
  const handleController = (controller: PaneController) => setActiveController(controller)

  const toggleCollapse = () => {
    setCollapsed((v) => {
      saveLocal(COLLAPSE_KEY, !v)
      return !v
    })
  }

  // PC당 창은 하나만 (중복 방지). 이미 있으면 활성화만.
  const openPane = (agentId: string) => {
    const existing = panes.find((p) => p.agentId === agentId)
    if (existing) {
      setActivePaneId(existing.paneId)
      return
    }
    const paneId = newId()
    updatePanes([...panes, { paneId, agentId }])
    setActivePaneId(paneId)
  }

  // 트리에서 한 번 클릭: 열려 있으면 닫고, 없으면 연다
  const togglePane = (agentId: string) => {
    const existing = panes.find((p) => p.agentId === agentId)
    if (existing) closePane(existing.paneId)
    else openPane(agentId)
  }

  const closePane = (paneId: string) => {
    const next = panes.filter((p) => p.paneId !== paneId)
    updatePanes(next)
    if (paneId === activePaneId) {
      setActivePaneId(next.length ? next[next.length - 1].paneId : null)
      setActiveController(null)
    }
  }

  const resizePane = (paneId: string, w: number, h: number) =>
    updatePanes(panes.map((p) => (p.paneId === paneId ? { ...p, w, h } : p)))

  const reorder = (fromPaneId: string, toPaneId: string) => {
    const from = panes.findIndex((p) => p.paneId === fromPaneId)
    const to = panes.findIndex((p) => p.paneId === toPaneId)
    if (from < 0 || to < 0 || from === to) return
    const next = panes.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    updatePanes(next)
  }

  return (
    <RemoteContext.Provider value={remoteContext}>
    <div className={`explorer-shell${collapsed ? ' tree-collapsed' : ''}`}>
      <PcTree
        agents={visibleAgents}
        groups={pcGroups}
        saveGroups={saveGroups}
        shares={shares}
        addShare={addShare}
        removeShare={removeShare}
        renameShare={renameShare}
        org={org}
        setAgentProject={setAgentProject}
        presence={presence}
        pcStatuses={pcStatuses}
        setPcStatus={setPcStatus}
        remoteUsage={remoteUsage}
        setFolderProject={setFolderProject}
        selfUserId={selfUserId}
        filterProjectId={filterProjectId}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        onOpenAgent={togglePane}
        selectedFolderId={selectedFolderId}
        onSelectFolder={setSelectedFolderId}
        mode={mode}
        onModeChange={switchMode}
      />

      <div className="explorer-main">
        {mode === 'remote' ? (
          <RemoteGrid
            sections={remoteTargets.sections}
            groupName={remoteTargets.name}
            displayName={(a) => displayName(a, pcGroups)}
            thumbnails={thumbnails}
            watchThumbnails={watchThumbnails}
            pcStatuses={pcStatuses}
            remoteUsage={remoteUsage}
            selfUserId={selfUserId}
            userName={(id) => org.users.find((u) => u.id === id)?.name ?? '다른 사용자'}
          />
        ) : (
          <>
        <ExplorerToolbar controller={activeController} />


        <div
          className={`workspace-grid${dropActive ? ' drop-active' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(AGENT_MIME)) {
              e.preventDefault()
              setDropActive(true)
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDropActive(false)
          }}
          onDrop={(e) => {
            setDropActive(false)
            const agentId = e.dataTransfer.getData(AGENT_MIME)
            if (agentId) {
              e.preventDefault()
              openPane(agentId)
            }
          }}
        >
          {panes.length === 0 && (
            <div className="workspace-empty">
              왼쪽에서 PC를 <b>드래그</b>하거나 <b>＋</b>를 눌러 이 영역에 파일 탐색기를 엽니다.
              <br />
              여러 PC를 나란히 열어 비교하거나 파일을 주고받을 수 있어요.
            </div>
          )}
          {panes.map((pane) => {
            return (
              <ExplorerPane
                key={pane.paneId}
                paneId={pane.paneId}
                agentId={pane.agentId}
                machineName={sourceName(pane.agentId)}
                online={sourceOnline(pane.agentId)}
                selfAgentId={selfOnline ? selfAgentId : null}
                active={pane.paneId === activePaneId}
                onActivate={() => setActivePaneId(pane.paneId)}
                onControllerChange={handleController}
                width={pane.w}
                height={pane.h}
                clipboard={clipboard}
                setClipboard={setClipboard}
                favorites={favorites.favorites[pane.agentId] ?? []}
                onAddFavorite={(p) => addFavorite(pane.agentId, p)}
                onRemoveFavorite={(p) => removeFavorite(pane.agentId, p)}
                onReorderFavorites={(paths) => setAgentFavorites(pane.agentId, paths)}
                subscribeTransfers={subscribeTransfers}
                watchRun={watchRun}
                selfUserId={selfUserId}
                pcStatus={pcStatuses[pane.agentId] ?? null}
                remoteUser={remoteUsage[pane.agentId]?.userId ?? null}
                userName={(id) => org.users.find((u) => u.id === id)?.name ?? '다른 사용자'}
                onClose={() => closePane(pane.paneId)}
                onReorderDrop={(fromPaneId) => reorder(fromPaneId, pane.paneId)}
                onResize={(w, h) => resizePane(pane.paneId, w, h)}
              />
            )
          })}
        </div>

        {/* 공용 하단 상태 표시줄 (활성 창 기준) */}
        <div className="explorer-status">
          {activeController ? (
            <>
              <span className="small muted">
                {activeController.itemCount}개 항목
                {activeController.selectionCount > 0 && ` · ${activeController.selectionCount}개 선택함`}
              </span>
              <span className="pane-status-views">
                <button type="button" className={activeController.view === 'details' ? 'active' : ''} title="자세히" onClick={() => activeController.setView('details')}>
                  <Icon name="view-details" size={15} />
                </button>
                <button type="button" className={activeController.view === 'icons' ? 'active' : ''} title="큰 아이콘" onClick={() => activeController.setView('icons')}>
                  <Icon name="view-grid" size={15} />
                </button>
              </span>
            </>
          ) : (
            <span className="small muted">창을 클릭하면 상태가 표시됩니다</span>
          )}
        </div>
          </>
        )}
      </div>
    </div>
    </RemoteContext.Provider>
  )
}
