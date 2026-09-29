import { useEffect, useMemo, useState } from 'react'
import type { Agent, Org, PcFavorites, PcGroups, SharedFolder } from '../api'
import type { SubscribeTransfers, WatchRun } from '../useDashboard'
import { ExplorerPane, type Pane } from './explorer/ExplorerPane'
import { ExplorerToolbar } from './explorer/ExplorerToolbar'
import type { PaneController } from './explorer/paneController'
import { PcTree } from './explorer/PcTree'
import { AGENT_MIME, displayName, type FileClipboard, newId } from './explorer/pcGroups'
import { TransfersBar } from './explorer/TransfersBar'

interface Props {
  agents: Agent[]
  pcGroups: PcGroups
  saveGroups: (groups: PcGroups) => void
  favorites: PcFavorites
  setAgentFavorites: (agentId: string, paths: string[]) => void
  shares: SharedFolder[]
  addShare: (name: string, path: string) => Promise<void>
  removeShare: (id: string) => void
  org: Org
  setAgentProject: (agentId: string, projectId: string | null) => Promise<void>
  presence: Record<string, string[]>
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

const COLLAPSE_KEY = 'pcm.explorer.collapsed'
const PANES_KEY = 'pcm.explorer.panes'

export function FileExplorer({ agents, pcGroups, saveGroups, favorites, setAgentFavorites, shares, addShare, removeShare, org, setAgentProject, presence, filterProjectId, selfUserId, announcePresence, subscribeTransfers, watchRun }: Props) {
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

  const addPane = (agentId: string) => {
    const paneId = newId()
    updatePanes([...panes, { paneId, agentId }])
    setActivePaneId(paneId)
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
    <div className={`explorer-shell${collapsed ? ' tree-collapsed' : ''}`}>
      <PcTree
        agents={visibleAgents}
        groups={pcGroups}
        saveGroups={saveGroups}
        shares={shares}
        addShare={addShare}
        removeShare={removeShare}
        org={org}
        setAgentProject={setAgentProject}
        presence={presence}
        filterProjectId={filterProjectId}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        onOpenAgent={addPane}
      />

      <div className="explorer-main">
        <ExplorerToolbar controller={activeController} />

        <div className="workspace-bar">
          <span className="workspace-left">
            <span className="muted small">열린 창 {panes.length}개</span>
            {clipboard && (
              <span className="clip-chip">
                {clipboard.mode === 'cut' ? '잘라냄' : '복사됨'}: <b className="ellipsis">{clipboard.items[0]?.name}{clipboard.items.length > 1 ? ` 외 ${clipboard.items.length - 1}` : ''}</b>
                <button type="button" className="icon-mini" title="지우기" onClick={() => setClipboard(null)}>
                  ✕
                </button>
              </span>
            )}
          </span>
          <span className="workspace-cols">
            <span className="muted small">창을 클릭하면 위 툴바가 그 창에 적용됩니다 · 모서리를 끌어 크기 조절</span>
            {panes.length > 0 && (
              <button type="button" className="link" onClick={() => { updatePanes([]); setActivePaneId(null); setActiveController(null) }}>
                모두 닫기
              </button>
            )}
          </span>
        </div>

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
              addPane(agentId)
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
                subscribeTransfers={subscribeTransfers}
                watchRun={watchRun}
                onClose={() => closePane(pane.paneId)}
                onReorderDrop={(fromPaneId) => reorder(fromPaneId, pane.paneId)}
                onResize={(w, h) => resizePane(pane.paneId, w, h)}
              />
            )
          })}
        </div>

        <TransfersBar agentById={agentById} subscribeTransfers={subscribeTransfers} />
      </div>
    </div>
  )
}
