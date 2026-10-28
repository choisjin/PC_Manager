import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from 'react'
import { api, type Agent, isLinuxAgent, type Org, PC_STATUS_LABEL, type PcGroups, type PcStatus, type PcStatusValue, type RemoteUsage, type SharedFolder } from '../../api'
import { ensureUnlocked, pcLockStore, usePcLocks } from '../../pcLocks'
import { UNGROUPED_FOLDER, useCan, useFolderAccess } from '../../perms'
import { askPin } from '../../pinPrompt'
import { HubBadges, HubPanel } from '../SideHub'
import { HUB_ICON, HUB_TABS, type HubTab, useHubReveal, useReportChatShown, useSideHub, useSidebarCovered } from '../sideHubState'
import { AddShareModal } from './AddShareModal'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { addFolder, AGENT_MIME, assignAgent, buildTree, deleteFolder, displayName, type FolderNode, renameFolder, setAlias } from './pcGroups'

interface Props {
  /**
   * files = PC Manager (Browser/Remote · 공유 서버·파일 즐겨찾기, PC를 누르면 창 열기/닫기),
   * results = Result 화면 (PC를 누르면 그 PC의 결과를 고른다). 폴더·별칭·상태·PIN 같은 PC 관리는 같다
   */
  variant?: 'files' | 'results'
  agents: Agent[]
  groups: PcGroups
  saveGroups: (groups: PcGroups) => void
  shares?: SharedFolder[]
  addShare?: (name: string, path: string, username?: string, password?: string) => Promise<void>
  removeShare?: (id: string) => void
  renameShare?: (id: string, name: string) => Promise<void>
  /** 목록에서 삭제 (연결 끊긴 PC만). 에이전트가 다시 연결하면 다시 나타난다 */
  removeAgent: (agentId: string) => Promise<void>
  reorderShares?: (ids: string[]) => void
  org: Org
  setAgentProject: (agentId: string, projectId: string | null) => Promise<void>
  presence: Record<string, string[]>
  pcStatuses: Record<string, PcStatus>
  setPcStatus: (agentId: string, status: PcStatusValue, note: string | null) => Promise<void>
  remoteUsage: RemoteUsage['inUseBy']
  setFolderProject: (folderId: string, projectId: string | null) => Promise<void>
  selfUserId: string | null
  filterProjectId: string | null
  collapsed: boolean
  onToggleCollapse: () => void
  onOpenAgent: (agentId: string) => void
  /** Remote 모드에서 그룹으로 쓸 폴더 (클릭으로 선택, 다시 클릭하면 해제). 없으면 폴더 줄을 누르면 펴고 접는다 */
  selectedFolderId?: string | null
  onSelectFolder?: (folderId: string | null) => void
  /** Browser(파일 탐색기) ↔ Remote(화면 미리보기) */
  mode?: 'browser' | 'remote'
  onModeChange?: (mode: 'browser' | 'remote') => void
  /** 공유 서버 옆 탭에 보일 내용 (파일 즐겨찾기) */
  fileFavorites?: ReactNode
  /** PC 목록 아래 PC 정보 패널 */
  infoPanel?: ReactNode
  /** PC 정보 패널이 보여 주는 PC (목록에 표시) */
  infoAgentId?: string | null
  /** PC 줄 끝에 붙일 것 (Result: 결과 형식·예약·분석 진행·▶ 최신) */
  renderAgentExtra?: (agent: Agent) => ReactNode
  /** PC 수 옆에 붙일 것 (Result: 결과 폴더를 정한 PC만) */
  headExtra?: ReactNode
  /** PC가 하나도 없을 때 글 */
  emptyText?: string
}

type SideTab = 'shares' | 'favorites'
const SIDE_TAB_KEY = 'pcm.tree.sideTab'

/** 사이드바 맨 위 탭: PC 목록 · 채팅 · 메모 · 진행상황 (마지막에 본 탭을 기억, PC Manager·Result 화면이 함께 쓴다) */
type MenuTab = 'pc' | HubTab
const MENU_TAB_KEY = 'pcm.side.menu'
// 사이드바 폭 (오른쪽 가장자리를 끌어 조절, 기억): PC 목록·진행상황 / 채팅·메모 (방 목록과 내용이 나란히 보이게 넓게)
type WidthKind = 'narrow' | 'wide'
const WIDTH_KEY: Record<WidthKind, string> = { narrow: 'pcm.side.w', wide: 'pcm.side.w.wide' }
const DEFAULT_WIDTH: Record<WidthKind, number> = { narrow: 260, wide: 460 }
const MIN_WIDTH = 200

const readMenuTab = (): MenuTab => {
  try {
    const saved = localStorage.getItem(MENU_TAB_KEY)
    return saved === 'chat' || saved === 'notes' || saved === 'transfers' ? saved : 'pc'
  } catch {
    return 'pc'
  }
}
const clampWidth = (w: number) => Math.round(Math.max(MIN_WIDTH, Math.min(window.innerWidth * 0.6, w)))
const readWidth = (kind: WidthKind) => {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY[kind]))
    return saved > 0 ? clampWidth(saved) : DEFAULT_WIDTH[kind]
  } catch {
    return DEFAULT_WIDTH[kind]
  }
}

export function PcTree({ variant = 'files', agents, groups, saveGroups, shares = [], addShare, removeShare, renameShare, removeAgent, reorderShares, org, setAgentProject, presence, pcStatuses, setPcStatus, remoteUsage, setFolderProject, selfUserId, filterProjectId, collapsed, onToggleCollapse, onOpenAgent, selectedFolderId = null, onSelectFolder, mode = 'browser', onModeChange, fileFavorites, infoPanel, infoAgentId, renderAgentExtra, headExtra, emptyText }: Props) {
  const files = variant === 'files'
  const pcLocks = usePcLocks()
  const { roots, ungrouped } = useMemo(() => buildTree(groups, agents), [groups, agents])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(groups.folders.map((f) => f.id)))
  const can = useCan()
  // PC 관리 권한: 상태·별칭·PIN·PC 목록 폴더·프로젝트 배정·목록에서 삭제
  const manage = can('pcManage')
  // PC 목록 폴더 권한: 볼 수 있는 폴더만 고치고 PC를 넣는다 (상위 폴더는 길로만 보임). 지우기는 아래 폴더까지 모두 볼 수 있을 때만
  const folders = useFolderAccess()
  const editable = (folderId: string) => manage && folders.opens(folderId)
  const deletable = (node: FolderNode): boolean => editable(node.folder.id) && node.children.every(deletable)
  const [editing, setEditing] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null) // folderId 또는 'root'
  // 끌기가 어디서 끝나든 놓기 표시를 끈다
  useEffect(() => {
    const clear = () => setDropTarget(null)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
    }
  }, [])
  const [menu, setMenu] = useState<{ x: number; y: number; agent: Agent } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; folderId: string; name: string; deletable: boolean } | null>(null)
  const [shareMenu, setShareMenu] = useState<{ x: number; y: number; share: SharedFolder } | null>(null)
  // 공유 폴더 순서 바꾸기 (끌어서 놓기)
  const [shareDrag, setShareDrag] = useState<string | null>(null)
  const [shareOver, setShareOver] = useState<{ id: string; after: boolean } | null>(null)
  const dropShare = (targetId: string, after: boolean) => {
    const from = shareDrag
    setShareDrag(null)
    setShareOver(null)
    if (!from || from === targetId) return
    const ids = shares.map((s) => s.id).filter((id) => id !== from)
    const index = ids.indexOf(targetId)
    ids.splice(after ? index + 1 : index, 0, from)
    reorderShares?.(ids)
  }

  const renameShareAlias = (share: SharedFolder) => {
    const name = window.prompt(`'${share.path}'의 별칭 (표시 이름)`, share.name)
    if (name === null || !name.trim() || name.trim() === share.name || !renameShare) return
    renameShare(share.id, name.trim()).catch((err) => window.alert(err instanceof Error ? err.message : String(err)))
  }

  // 폴더에 프로젝트가 배정돼 있으면 그 프로젝트 사용자(또는 그 프로젝트로 들어온 사람)에게만 보인다
  const folderVisible = (folderId: string) => {
    if (!folders.shows(folderId)) return false
    const pid = org.folderProjects?.[folderId]
    if (!pid) return true
    if (filterProjectId) return pid === filterProjectId
    return selfUserId ? (org.projectUsers[pid] ?? []).includes(selfUserId) : true
  }
  const [showAddShare, setShowAddShare] = useState(false)
  // PC 목록 위: 공유 서버 / 파일 즐겨찾기 탭 (마지막에 본 탭을 기억)
  const [sideTab, setSideTabState] = useState<SideTab>(() => {
    try {
      return localStorage.getItem(SIDE_TAB_KEY) === 'favorites' ? 'favorites' : 'shares'
    } catch {
      return 'shares'
    }
  })
  const setSideTab = (tab: SideTab) => {
    setSideTabState(tab)
    try {
      localStorage.setItem(SIDE_TAB_KEY, tab)
    } catch {
      // 저장 못 해도 탭 전환은 된다
    }
  }
  const [hover, setHover] = useState<{ agentId: string; x: number; y: number } | null>(null)

  const onlineCount = agents.filter((a) => a.online).length

  // 프레즌스/할당 도우미
  const userName = (userId: string) => org.users.find((u) => u.id === userId)?.name ?? '알 수 없음'
  const projectName = (agentId: string) => {
    const pid = org.agentProjects[agentId]
    return pid ? org.projects.find((p) => p.id === pid)?.name : undefined
  }
  const viewersOf = (agentId: string) => (presence[agentId] ?? []).map(userName)
  const accessUsersOf = (agentId: string) => {
    const pid = org.agentProjects[agentId]
    if (!pid) return []
    return (org.projectUsers[pid] ?? []).map(userName)
  }

  const toggleFolder = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const createFolder = (parentId: string | null) => {
    const next = addFolder(groups, '새 폴더', parentId)
    const created = next.folders[next.folders.length - 1]
    if (parentId) setExpanded((prev) => new Set(prev).add(parentId))
    saveGroups(next)
    setEditing(created.id)
  }

  const handleDropAgent = (e: React.DragEvent, folderId: string | null) => {
    const agentId = e.dataTransfer.getData(AGENT_MIME)
    setDropTarget(null)
    if (agentId && editable(folderId ?? UNGROUPED_FOLDER)) {
      e.preventDefault()
      saveGroups(assignAgent(groups, agentId, folderId))
    }
  }

  const allowAgentDrop = (e: React.DragEvent, key: string) => {
    if (editable(key === 'root' ? UNGROUPED_FOLDER : key) && e.dataTransfer.types.includes(AGENT_MIME)) {
      e.preventDefault()
      setDropTarget(key)
    }
  }

  // 맨 위 탭: PC 목록 · 채팅 · 메모 · 진행상황 (App이 SideHub를 넘겼을 때)
  const hub = useSideHub()
  const [menuTab, setMenuTabState] = useState<MenuTab>(readMenuTab)
  const tab: MenuTab = hub ? menuTab : 'pc'
  const chooseTab = (next: MenuTab) => {
    setMenuTabState(next)
    try {
      localStorage.setItem(MENU_TAB_KEY, next)
    } catch {
      // 기억만 못 한다
    }
  }
  // 원격조작 창·전체 화면·결과 확인 전체 화면이 사이드바를 가리고 있으면 채팅을 보고 있는 게 아니다 (그때는 PiP가 그 위에 뜬다)
  const covered = useSidebarCovered()
  useReportChatShown(hub, 'side', !collapsed && !covered && tab === 'chat')
  // 알림을 누름·결과 확인을 불러옴: 그 탭으로 펼친다 (분석이 시작·끝난 것은 탭 배지로만 — 보던 PC 목록을 바꾸지 않게)
  useHubReveal(hub, (r) => {
    if (r.reason !== 'user' || covered) return
    chooseTab(r.tab)
    if (collapsed) onToggleCollapse()
  })
  const widthKind: WidthKind = tab === 'chat' || tab === 'notes' ? 'wide' : 'narrow'
  const [widths, setWidths] = useState<Record<WidthKind, number>>(() => ({ narrow: readWidth('narrow'), wide: readWidth('wide') }))
  const saveWidth = (kind: WidthKind, w: number | null) => {
    try {
      if (w === null) localStorage.removeItem(WIDTH_KEY[kind])
      else localStorage.setItem(WIDTH_KEY[kind], String(w))
    } catch {
      // 기억만 못 한다
    }
  }
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const kind = widthKind
    const startX = e.clientX
    const startW = widths[kind]
    let last = startW
    const onMove = (ev: MouseEvent) => {
      last = clampWidth(startW + ev.clientX - startX)
      setWidths((w) => ({ ...w, [kind]: last }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      saveWidth(kind, last)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const resetWidth = () => {
    setWidths((w) => ({ ...w, [widthKind]: DEFAULT_WIDTH[widthKind] }))
    saveWidth(widthKind, null)
  }

  if (collapsed) {
    return (
      <aside className="panel pc-tree collapsed">
        <button type="button" className="icon tree-expand" title="PC 목록 펼치기" onClick={onToggleCollapse}>
          ▸
        </button>
        {hub && HUB_TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className="icon side-menu-icon"
            title={label}
            aria-label={label}
            onClick={() => {
              chooseTab(k)
              onToggleCollapse()
            }}
          >
            <span aria-hidden="true">{HUB_ICON[k]}</span>
            <HubBadges hub={hub} tab={k} />
          </button>
        ))}
      </aside>
    )
  }

  const openAgentMenu = (e: React.MouseEvent, agent: Agent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, agent })
  }

  const editAlias = (agent: Agent) => {
    const alias = window.prompt(`'${agent.machineName}'의 별칭`, groups.aliases?.[agent.id] ?? '')
    if (alias === null) return
    saveGroups(setAlias(groups, agent.id, alias))
  }

  // 트리 들여쓰기: 한 단계 10px. PC는 같은 단계 폴더의 아이콘 위치(펼침 화살표 칸 다음)에 맞춘다
  const INDENT = 10
  const CARET = 18
  const folderPad = (depth: number) => 3 + depth * INDENT
  const agentPad = (depth: number) => 3 + depth * INDENT + CARET

  const renderAgent = (agent: Agent, depth: number) => {
    const lock = pcLocks[agent.id]
    const alias = groups.aliases?.[agent.id]?.trim()
    const viewers = viewersOf(agent.id)
    const status = pcStatuses[agent.id]
    const remoteBy = remoteUsage[agent.id]?.userId ?? null
    const proj = filterProjectId ? undefined : projectName(agent.id)
    return (
      <li
        key={agent.id}
        className={`tree-agent${agent.online ? '' : ' offline'}${agent.id === infoAgentId ? ' info-target' : ''}`}
        style={{ paddingLeft: agentPad(depth) }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(AGENT_MIME, agent.id)
          e.dataTransfer.effectAllowed = 'copyMove'
        }}
        onClick={() => onOpenAgent(agent.id)}
        // Result: 키보드로도 PC를 고른다 (전처럼 Tab으로 옮겨 Enter)
        role={files ? undefined : 'button'}
        tabIndex={files ? undefined : 0}
        onKeyDown={files ? undefined : (e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget) onOpenAgent(agent.id)
        }}
        onContextMenu={(e) => openAgentMenu(e, agent)}
        onMouseEnter={(e) => setHover({ agentId: agent.id, x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().top })}
        onMouseLeave={() => setHover((h) => (h?.agentId === agent.id ? null : h))}
        title={files ? '클릭하면 창 열기/닫기' : '클릭하면 이 PC의 결과를 봅니다'}
      >
        <span className={`dot ${agent.online ? 'on' : 'off'}`} />
        <span className="ellipsis" translate="no">{displayName(agent, groups)}</span>
        {lock && (
          <span className={`pc-lock-badge${lock.unlocked ? ' open' : ''}`} title={lock.unlocked ? 'PIN 잠금 (이 브라우저에서 풀림)' : 'PIN 잠금 — 열 때 PIN 입력'}>
            {lock.unlocked ? '🔓' : '🔒'}
          </span>
        )}
        {proj && <span className="proj-badge">{proj}</span>}
        {alias && <span className="tree-host mono">{agent.machineName}</span>}
        {status && status.status !== 'available' && (
          <span className={`status-badge ${status.status}`} title={`${PC_STATUS_LABEL[status.status]}${status.note ? ` · ${status.note}` : ''}`}>
            {PC_STATUS_LABEL[status.status]}
          </span>
        )}
        {remoteBy && <span className="remote-badge-tree" title={`원격조작 중: ${userName(remoteBy)}`}>원격 {userName(remoteBy)}</span>}
        {viewers.length > 0 && <span className="using-badge" title={`사용 중: ${viewers.join(', ')}`}>● {viewers.length}</span>}
        {renderAgentExtra?.(agent)}
      </li>
    )
  }

  const renderFolder = (node: FolderNode, depth: number) => {
    if (!folderVisible(node.folder.id)) return null
    const isOpen = expanded.has(node.folder.id)
    const isDrop = dropTarget === node.folder.id
    const folderProj = org.folderProjects?.[node.folder.id]
    const folderProjName = folderProj ? org.projects.find((p) => p.id === folderProj)?.name : undefined
    return (
      <li key={node.folder.id}>
        <div
          className={`tree-folder${isDrop ? ' drop-active' : ''}${selectedFolderId === node.folder.id ? ' selected' : ''}`}
          style={{ paddingLeft: folderPad(depth) }}
          onClick={(e) => {
            if (onSelectFolder) onSelectFolder(selectedFolderId === node.folder.id ? null : node.folder.id)
            // 고를 폴더가 없는 화면(Result): 줄을 누르면 펴고 접는다 (화살표는 그 자리에서 이미 펴고 접음)
            else if (!(e.target as HTMLElement).closest('.tree-caret, .tree-folder-actions, input')) toggleFolder(node.folder.id)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            if (editable(node.folder.id)) setFolderMenu({ x: e.clientX, y: e.clientY, folderId: node.folder.id, name: node.folder.name, deletable: deletable(node) })
          }}
          onDragOver={(e) => allowAgentDrop(e, node.folder.id)}
          onDragLeave={() => setDropTarget((t) => (t === node.folder.id ? null : t))}
          onDrop={(e) => handleDropAgent(e, node.folder.id)}
        >
          <button type="button" className="tree-caret" onClick={() => toggleFolder(node.folder.id)}>
            {node.children.length > 0 || node.agents.length > 0 ? (isOpen ? '▾' : '▸') : '·'}
          </button>
          <span className="tree-folder-icon" aria-hidden="true">
            📂
          </span>
          {editing === node.folder.id ? (
            <input
              className="tree-rename"
              autoFocus
              defaultValue={node.folder.name}
              onBlur={(e) => {
                saveGroups(renameFolder(groups, node.folder.id, e.target.value))
                setEditing(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span
              className={`tree-folder-name ellipsis${folders.opens(node.folder.id) ? '' : ' muted'}`}
              translate="no"
              title={folders.opens(node.folder.id) ? undefined : '이 폴더의 PC는 볼 권한이 없습니다 (아래 폴더만)'}
              onDoubleClick={() => editable(node.folder.id) && setEditing(node.folder.id)}
            >
              {node.folder.name}
            </span>
          )}
          {folderProjName && !filterProjectId && <span className="proj-badge">{folderProjName}</span>}
          {editable(node.folder.id) && (
          <span className="tree-folder-actions">
            <button type="button" className="icon-mini" title="하위 폴더" onClick={() => createFolder(node.folder.id)}>
              ＋
            </button>
            <button type="button" className="icon-mini" title="이름 바꾸기" onClick={() => setEditing(node.folder.id)}>
              ✎
            </button>
            <button
              type="button"
              className="icon-mini"
              title={deletable(node) ? '폴더 삭제 (PC는 미분류로)' : '볼 권한이 없는 하위 폴더가 있어 지울 수 없습니다'}
              disabled={!deletable(node)}
              onClick={() => saveGroups(deleteFolder(groups, node.folder.id))}
            >
              ✕
            </button>
          </span>
          )}
        </div>
        {isOpen && (
          <ul className="tree-children">
            {node.children.map((child) => renderFolder(child, depth + 1))}
            {node.agents.map((agent) => renderAgent(agent, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <aside className={`panel pc-tree${files ? '' : ' results'}`} style={{ '--side-w': `${widths[widthKind]}px` } as CSSProperties}>
      <div className="side-menu" role="tablist" aria-label="사이드 메뉴">
        <button type="button" className="icon tree-collapse" title="접기" onClick={onToggleCollapse}>
          ◂
        </button>
        <button type="button" role="tab" aria-selected={tab === 'pc'} className={tab === 'pc' ? 'active' : ''} onClick={() => chooseTab('pc')}>
          PC
        </button>
        {hub && HUB_TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => chooseTab(k)}>
            {label}
            <HubBadges hub={hub} tab={k} />
          </button>
        ))}
      </div>

      {hub && tab !== 'pc' ? (
        <div className={`side-hub${tab === 'transfers' ? ' pip-body' : ''}`}>
          <HubPanel hub={hub} tab={tab} shown={!covered} />
        </div>
      ) : (
      <>
      <div className="panel-head">
        {files && onModeChange && (
          <div className="tree-head-row">
            <span className="segmented" role="radiogroup" aria-label="모드">
              <button type="button" role="radio" aria-checked={mode === 'browser'} className={mode === 'browser' ? 'active' : ''} onClick={() => onModeChange('browser')}>
                Browser
              </button>
              {can('remote') && (
                <button type="button" role="radio" aria-checked={mode === 'remote'} className={mode === 'remote' ? 'active' : ''} onClick={() => onModeChange('remote')}>
                  Remote
                </button>
              )}
            </span>
          </div>
        )}
        <div className="tree-head-row">
          <span className="muted small">{onlineCount}/{agents.length}</span>
          {headExtra}
          <span className="head-actions">
            {manage && (
              <button type="button" className="small-btn" title="폴더 추가" onClick={() => createFolder(null)}>
                + 폴더
              </button>
            )}
            {files && addShare && (
              <button type="button" className="small-btn" title="공유 폴더 등록" onClick={() => setShowAddShare(true)}>
                + 서버
              </button>
            )}
          </span>
        </div>
      </div>

      {files && (
      <div className="share-section">
        <div className="share-head">
          <span className="side-tabs" role="tablist" aria-label="공유 서버 / 파일 즐겨찾기">
            <button type="button" role="tab" aria-selected={sideTab === 'shares'} className={sideTab === 'shares' ? 'active' : ''} onClick={() => setSideTab('shares')}>
              공유 서버
            </button>
            <button type="button" role="tab" aria-selected={sideTab === 'favorites'} className={sideTab === 'favorites' ? 'active' : ''} onClick={() => setSideTab('favorites')}>
              파일 즐겨찾기
            </button>
          </span>
          {/* 탭을 바꿔도 머리 높이가 그대로이게 자리는 남긴다 */}
          <button
            type="button"
            className="small-btn"
            style={sideTab === 'shares' ? undefined : { visibility: 'hidden' }}
            title={selfUserId ? '공유 폴더 등록 (내 목록에만 저장)' : '사용자를 선택(로그인)해야 공유 폴더를 등록할 수 있습니다'}
            disabled={!selfUserId}
            onClick={() => setShowAddShare(true)}
          >
            ＋
          </button>
        </div>
        {sideTab === 'favorites' ? fileFavorites : (
        <ul className="tree-root share-list">
          {shares.length === 0 && (
            <li className="placeholder small">{selfUserId ? '등록된 공유 폴더가 없습니다' : '사용자를 선택하면 내 공유 폴더가 보입니다'}</li>
          )}
          {shares.map((s) => (
            <li
              key={s.id}
              className={`tree-agent share-item${shareDrag === s.id ? ' dragging' : ''}${shareOver?.id === s.id ? (shareOver.after ? ' drop-after' : ' drop-before') : ''}`}
              title={`${s.path}${s.username ? ` · ${s.username}` : ''}${s.ownerUserId ? '' : ' · 공용(예전 등록)'} — 클릭: 창 열기/닫기 · 끌어서 순서 변경 · 우클릭 메뉴`}
              draggable
              onDragStart={(e) => {
                setShareDrag(s.id)
                e.dataTransfer.setData('application/x-pcm-share', s.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => {
                setShareDrag(null)
                setShareOver(null)
              }}
              onDragOver={(e) => {
                if (!shareDrag) return
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                setShareOver({ id: s.id, after: e.clientY > rect.top + rect.height / 2 })
              }}
              onDrop={(e) => {
                if (!shareDrag) return
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                dropShare(s.id, e.clientY > rect.top + rect.height / 2)
              }}
              onClick={() => onOpenAgent(s.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setShareMenu({ x: e.clientX, y: e.clientY, share: s })
              }}
            >
              <Icon name="drive" size={14} />
              <span className="ellipsis" translate="no">{s.name}</span>
              <button
                type="button"
                className="icon-mini"
                title="공유 폴더 삭제"
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm(`'${s.name}' 공유 폴더를 목록에서 제거할까요? (실제 파일은 지워지지 않습니다)`)) removeShare?.(s.id)
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        )}
      </div>
      )}

      <ul className="tree-root">
        {roots.map((node) => renderFolder(node, 0))}

        {folders.opens(UNGROUPED_FOLDER) && (
        <li>
          <div
            className={`tree-folder ungrouped${dropTarget === 'root' ? ' drop-active' : ''}`}
            style={{ paddingLeft: folderPad(0) }}
            onDragOver={(e) => allowAgentDrop(e, 'root')}
            onDragLeave={() => setDropTarget((t) => (t === 'root' ? null : t))}
            onDrop={(e) => handleDropAgent(e, null)}
          >
            <span className="tree-caret">·</span>
            <span className="tree-folder-name muted">미분류 ({ungrouped.length})</span>
          </div>
          <ul className="tree-children">{ungrouped.map((agent) => renderAgent(agent, 1))}</ul>
        </li>
        )}

        {agents.length === 0 && <li className="placeholder small">{emptyText ?? (folders.limited ? '볼 수 있는 PC가 없습니다 (PC 폴더 권한)' : '등록된 PC가 없습니다')}</li>}
      </ul>

      {infoPanel}
      </>
      )}

      <div className="side-resizer" title="끌어서 폭 조절 · 더블클릭: 기본 폭" onMouseDown={startResize} onDoubleClick={resetWidth} />

      {showAddShare && addShare && <AddShareModal onConfirm={addShare} onClose={() => setShowAddShare(false)} />}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={((): MenuItem[] => {
            const a = menu.agent
            const currentPid = org.agentProjects[a.id]
            const projectItems: MenuItem[] = org.projects.map((p) => ({
              label: `${currentPid === p.id ? '● ' : ''}${p.name}`,
              onClick: () => void setAgentProject(a.id, p.id),
            }))
            const current = pcStatuses[a.id]?.status ?? 'available'
            const statusItems: MenuItem[] = (['available', 'testing', 'forbidden', 'maintenance'] as PcStatusValue[]).map((v) => ({
              label: `${current === v ? '● ' : ''}상태: ${PC_STATUS_LABEL[v]}`,
              onClick: () => {
                if (v === 'available') {
                  void setPcStatus(a.id, v, null)
                  return
                }
                const note = window.prompt(`'${displayName(a, groups)}' → ${PC_STATUS_LABEL[v]}\n메모 (선택, 예: 담당자·테스트 내용)`, pcStatuses[a.id]?.note ?? '')
                if (note === null) return
                void setPcStatus(a.id, v, note.trim() || null)
              },
            }))
            const remoteBy = remoteUsage[a.id]?.userId
            const name = displayName(a, groups)
            const lock = pcLocks[a.id]
            const fail = (what: string) => (err: unknown) => window.alert(`${what}: ${err instanceof Error ? err.message : String(err)}`)
            const lockItems: MenuItem[] = lock
              ? [
                  ...(lock.unlocked
                    ? [{ label: '🔒 이 브라우저에서 다시 잠그기', onClick: () => void api.relockPc(a.id).then(pcLockStore.reload, fail('잠그지 못했습니다')) }]
                    : [{ label: '🔓 PIN 입력해서 풀기…', onClick: () => void ensureUnlocked(a.id) }]),
                  {
                    label: 'PIN 변경…',
                    onClick: async () => {
                      const pin = await askPin({ title: `'${name}' 지금 PIN` })
                      if (pin === null) return
                      const next = await askPin({ title: `'${name}' 새 PIN`, confirm: true })
                      if (next === null) return
                      api.changePcPin(a.id, pin, next).then(() => window.alert('PIN을 바꿨습니다. 다른 브라우저는 새 PIN을 넣어야 합니다.'), fail('바꾸지 못했습니다'))
                    },
                  },
                  {
                    label: 'PIN 잠금 없애기…',
                    onClick: async () => {
                      const pin = await askPin({ title: `'${name}' PIN 잠금 없애기`, message: 'PIN을 넣으면 잠금이 풀려 누구나 탐색·원격조작하고 썸네일도 보입니다.' })
                      if (pin === null) return
                      api.removePcLock(a.id, pin).then(pcLockStore.reload, fail('없애지 못했습니다'))
                    },
                  },
                ]
              : [
                  {
                    label: '🔒 PIN 잠금 (내 PC)…',
                    onClick: async () => {
                      const pin = await askPin({
                        title: `'${name}' PIN 잠금`,
                        message: '잠그면 PIN을 넣은 브라우저에서만 이 PC를 탐색·원격조작할 수 있고, 원격 썸네일은 누구에게도 보이지 않습니다.',
                        confirm: true,
                      })
                      if (pin === null) return
                      api.lockPc(a.id, pin).then(pcLockStore.reload, fail('잠그지 못했습니다'))
                    },
                  },
                ]
            if (!manage) return [{ label: '열기', onClick: () => onOpenAgent(a.id) }]
            return [
              { label: '열기', onClick: () => onOpenAgent(a.id) },
              ...(remoteBy
                ? [{
                    label: `원격 사용 중 표시 지우기 (${userName(remoteBy)})`,
                    onClick: () => {
                      if (!window.confirm(`'${displayName(a, groups)}'의 '원격 ${userName(remoteBy)}' 표시를 지울까요?\n\n원격 창을 닫았는데도 표시가 남았을 때만 쓰세요.`)) return
                      api.clearRemoteUsage(a.id).catch((err) => window.alert(`지우지 못했습니다: ${err instanceof Error ? err.message : String(err)}`))
                    },
                  }]
                : []),
              { separator: true },
              ...lockItems,
              { separator: true },
              ...statusItems,
              { separator: true },
              { label: groups.aliases?.[a.id] ? '별칭 변경…' : '별칭 지정…', onClick: () => editAlias(a) },
              ...(groups.aliases?.[a.id]
                ? [{ label: '별칭 제거', onClick: () => saveGroups(setAlias(groups, a.id, '')) }]
                : []),
              { separator: true },
              ...(org.projects.length > 0
                ? projectItems
                : [{ label: '프로젝트 없음 (설정에서 추가)', disabled: true, onClick: () => {} }]),
              ...(currentPid ? [{ label: '프로젝트 해제', onClick: () => void setAgentProject(a.id, null) }] : []),
              ...(isLinuxAgent(a)
                ? [
                    { separator: true },
                    {
                      label: 'Xorg로 전환 후 재시작 (원격조작용)…',
                      disabled: !a.online,
                      onClick: () => {
                        const name = displayName(a, groups)
                        if (!window.confirm(
                          `'${name}'의 로그인 화면·데스크톱을 Xorg(X11)로 바꾸고 PC를 재부팅합니다.\n\n` +
                            '원격조작은 X11에서만 됩니다 (Wayland는 화면 캡처가 막혀 있음).\n' +
                            '로그인한 사용자의 저장하지 않은 작업은 사라집니다. 계속할까요?',
                        )) return
                        api
                          .switchToX11(a.id)
                          .then(() => window.alert(`'${name}'을(를) 재부팅합니다. 1~2분 뒤 다시 연결되면 원격조작을 열어 보세요.`))
                          .catch((err) => window.alert(`전환하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`))
                      },
                    },
                  ]
                : []),
              { separator: true },
              {
                label: a.online ? '목록에서 삭제 (연결 끊긴 PC만)' : '목록에서 삭제…',
                danger: true,
                disabled: a.online,
                onClick: () => {
                  if (!window.confirm(`'${displayName(a, groups)}'을(를) PC 목록에서 삭제할까요?

이 PC의 에이전트가 다시 연결하면 목록에 다시 나타납니다.`)) return
                  removeAgent(a.id).catch((err) => window.alert(`삭제하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`))
                },
              },
            ]
          })()}
        />
      )}

      {shareMenu && (
        <ContextMenu
          x={shareMenu.x}
          y={shareMenu.y}
          onClose={() => setShareMenu(null)}
          items={[
            { label: '열기', onClick: () => onOpenAgent(shareMenu.share.id) },
            { separator: true },
            { label: '별칭 변경…', onClick: () => renameShareAlias(shareMenu.share) },
            { label: '경로 복사', onClick: () => void navigator.clipboard?.writeText(shareMenu.share.path).catch(() => {}) },
            { separator: true },
            {
              label: '목록에서 제거',
              danger: true,
              onClick: () => {
                const s = shareMenu.share
                if (window.confirm(`'${s.name}' 공유 폴더를 목록에서 제거할까요? (실제 파일은 지워지지 않습니다)`)) removeShare?.(s.id)
              },
            },
          ]}
        />
      )}

      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          items={((): MenuItem[] => {
            const currentPid = org.folderProjects?.[folderMenu.folderId]
            return [
              { label: '하위 폴더 만들기', onClick: () => createFolder(folderMenu.folderId) },
              { label: '이름 바꾸기', onClick: () => setEditing(folderMenu.folderId) },
              { separator: true },
              ...(org.projects.length > 0
                ? org.projects.map((p) => ({
                    label: `${currentPid === p.id ? '● ' : ''}프로젝트: ${p.name}`,
                    onClick: () => void setFolderProject(folderMenu.folderId, p.id),
                  }))
                : [{ label: '프로젝트 없음 (설정에서 추가)', disabled: true, onClick: () => {} }]),
              ...(currentPid ? [{ label: '프로젝트 해제 (모두에게 보임)', onClick: () => void setFolderProject(folderMenu.folderId, null) }] : []),
              { separator: true },
              {
                label: folderMenu.deletable ? '폴더 삭제 (PC는 미분류로)' : '폴더 삭제 (볼 권한이 없는 하위 폴더가 있음)',
                danger: true,
                disabled: !folderMenu.deletable,
                onClick: () => saveGroups(deleteFolder(groups, folderMenu.folderId)),
              },
            ]
          })()}
        />
      )}

      {hover && (viewersOf(hover.agentId).length > 0 || accessUsersOf(hover.agentId).length > 0) && (
        <div className="presence-pop" style={{ left: hover.x + 6, top: hover.y }}>
          <div className="presence-row">
            <span className="presence-label">사용 중</span>
            <span>{viewersOf(hover.agentId).length ? viewersOf(hover.agentId).join(', ') : '없음'}</span>
          </div>
          <div className="presence-row">
            <span className="presence-label">접근 가능</span>
            <span>{accessUsersOf(hover.agentId).length ? accessUsersOf(hover.agentId).join(', ') : '전체'}</span>
          </div>
        </div>
      )}
    </aside>
  )
}
