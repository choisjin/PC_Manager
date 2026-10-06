import { useMemo, useState } from 'react'
import { api, type Agent, isLinuxAgent, type Org, PC_STATUS_LABEL, type PcGroups, type PcStatus, type PcStatusValue, type RemoteUsage, type SharedFolder } from '../../api'
import { AddShareModal } from './AddShareModal'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { addFolder, AGENT_MIME, assignAgent, buildTree, deleteFolder, displayName, type FolderNode, renameFolder, setAlias } from './pcGroups'

interface Props {
  agents: Agent[]
  groups: PcGroups
  saveGroups: (groups: PcGroups) => void
  shares: SharedFolder[]
  addShare: (name: string, path: string, username?: string, password?: string) => Promise<void>
  removeShare: (id: string) => void
  renameShare: (id: string, name: string) => Promise<void>
  /** 목록에서 삭제 (연결 끊긴 PC만). 에이전트가 다시 연결하면 다시 나타난다 */
  removeAgent: (agentId: string) => Promise<void>
  reorderShares: (ids: string[]) => void
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
  /** Remote 모드에서 그룹으로 쓸 폴더 (클릭으로 선택, 다시 클릭하면 해제) */
  selectedFolderId: string | null
  onSelectFolder: (folderId: string | null) => void
  /** Browser(파일 탐색기) ↔ Remote(화면 미리보기) */
  mode: 'browser' | 'remote'
  onModeChange: (mode: 'browser' | 'remote') => void
}

export function PcTree({ agents, groups, saveGroups, shares, addShare, removeShare, renameShare, removeAgent, reorderShares, org, setAgentProject, presence, pcStatuses, setPcStatus, remoteUsage, setFolderProject, selfUserId, filterProjectId, collapsed, onToggleCollapse, onOpenAgent, selectedFolderId, onSelectFolder, mode, onModeChange }: Props) {
  const { roots, ungrouped } = useMemo(() => buildTree(groups, agents), [groups, agents])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(groups.folders.map((f) => f.id)))
  const [editing, setEditing] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null) // folderId 또는 'root'
  const [menu, setMenu] = useState<{ x: number; y: number; agent: Agent } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; folderId: string; name: string } | null>(null)
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
    reorderShares(ids)
  }

  const renameShareAlias = (share: SharedFolder) => {
    const name = window.prompt(`'${share.path}'의 별칭 (표시 이름)`, share.name)
    if (name === null || !name.trim() || name.trim() === share.name) return
    renameShare(share.id, name.trim()).catch((err) => window.alert(err instanceof Error ? err.message : String(err)))
  }

  // 폴더에 프로젝트가 배정돼 있으면 그 프로젝트 사용자(또는 그 프로젝트로 들어온 사람)에게만 보인다
  const folderVisible = (folderId: string) => {
    const pid = org.folderProjects?.[folderId]
    if (!pid) return true
    if (filterProjectId) return pid === filterProjectId
    return selfUserId ? (org.projectUsers[pid] ?? []).includes(selfUserId) : true
  }
  const [showAddShare, setShowAddShare] = useState(false)
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
    if (agentId) {
      e.preventDefault()
      saveGroups(assignAgent(groups, agentId, folderId))
    }
  }

  const allowAgentDrop = (e: React.DragEvent, key: string) => {
    if (e.dataTransfer.types.includes(AGENT_MIME)) {
      e.preventDefault()
      setDropTarget(key)
    }
  }

  if (collapsed) {
    return (
      <aside className="panel pc-tree collapsed">
        <button type="button" className="icon tree-expand" title="PC 목록 펼치기" onClick={onToggleCollapse}>
          ▸
        </button>
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
    const alias = groups.aliases?.[agent.id]?.trim()
    const viewers = viewersOf(agent.id)
    const status = pcStatuses[agent.id]
    const remoteBy = remoteUsage[agent.id]?.userId ?? null
    const proj = filterProjectId ? undefined : projectName(agent.id)
    return (
      <li
        key={agent.id}
        className={`tree-agent${agent.online ? '' : ' offline'}`}
        style={{ paddingLeft: agentPad(depth) }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(AGENT_MIME, agent.id)
          e.dataTransfer.effectAllowed = 'copyMove'
        }}
        onClick={() => onOpenAgent(agent.id)}
        onContextMenu={(e) => openAgentMenu(e, agent)}
        onMouseEnter={(e) => setHover({ agentId: agent.id, x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().top })}
        onMouseLeave={() => setHover((h) => (h?.agentId === agent.id ? null : h))}
        title="클릭하면 창 열기/닫기"
      >
        <span className={`dot ${agent.online ? 'on' : 'off'}`} />
        <span className="ellipsis">{displayName(agent, groups)}</span>
        {proj && <span className="proj-badge">{proj}</span>}
        {alias && <span className="tree-host mono">{agent.machineName}</span>}
        {status && status.status !== 'available' && (
          <span className={`status-badge ${status.status}`} title={`${PC_STATUS_LABEL[status.status]}${status.note ? ` · ${status.note}` : ''}`}>
            {PC_STATUS_LABEL[status.status]}
          </span>
        )}
        {remoteBy && <span className="remote-badge-tree" title={`원격조작 중: ${userName(remoteBy)}`}>원격 {userName(remoteBy)}</span>}
        {viewers.length > 0 && <span className="using-badge" title={`사용 중: ${viewers.join(', ')}`}>● {viewers.length}</span>}
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
          onClick={() => onSelectFolder(selectedFolderId === node.folder.id ? null : node.folder.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            setFolderMenu({ x: e.clientX, y: e.clientY, folderId: node.folder.id, name: node.folder.name })
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
            <span className="tree-folder-name ellipsis" onDoubleClick={() => setEditing(node.folder.id)}>
              {node.folder.name}
            </span>
          )}
          {folderProjName && !filterProjectId && <span className="proj-badge">{folderProjName}</span>}
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
              title="폴더 삭제 (PC는 미분류로)"
              onClick={() => saveGroups(deleteFolder(groups, node.folder.id))}
            >
              ✕
            </button>
          </span>
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
    <aside className="panel pc-tree">
      <div className="panel-head">
        <div className="tree-head-row">
          <button type="button" className="icon tree-collapse" title="접기" onClick={onToggleCollapse}>
            ◂
          </button>
          <span className="segmented" role="radiogroup" aria-label="모드">
            <button type="button" role="radio" aria-checked={mode === 'browser'} className={mode === 'browser' ? 'active' : ''} onClick={() => onModeChange('browser')}>
              Browser
            </button>
            <button type="button" role="radio" aria-checked={mode === 'remote'} className={mode === 'remote' ? 'active' : ''} onClick={() => onModeChange('remote')}>
              Remote
            </button>
          </span>
        </div>
        <div className="tree-head-row">
          <span className="muted small">{onlineCount}/{agents.length}</span>
          <span className="head-actions">
            <button type="button" className="small-btn" title="폴더 추가" onClick={() => createFolder(null)}>
              + 폴더
            </button>
            <button type="button" className="small-btn" title="공유 폴더 등록" onClick={() => setShowAddShare(true)}>
              + 서버
            </button>
          </span>
        </div>
      </div>

      <div className="share-section">
        <div className="share-head">
          <span className="pane-side-title">공유 서버</span>
          <button
            type="button"
            className="small-btn"
            title={selfUserId ? '공유 폴더 등록 (내 목록에만 저장)' : '사용자를 선택(로그인)해야 공유 폴더를 등록할 수 있습니다'}
            disabled={!selfUserId}
            onClick={() => setShowAddShare(true)}
          >
            ＋
          </button>
        </div>
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
              <span className="ellipsis">{s.name}</span>
              <button
                type="button"
                className="icon-mini"
                title="공유 폴더 삭제"
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm(`'${s.name}' 공유 폴더를 목록에서 제거할까요? (실제 파일은 지워지지 않습니다)`)) removeShare(s.id)
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </div>

      <ul className="tree-root">
        {roots.map((node) => renderFolder(node, 0))}

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

        {agents.length === 0 && <li className="placeholder small">등록된 PC가 없습니다</li>}
      </ul>


      {showAddShare && <AddShareModal onConfirm={addShare} onClose={() => setShowAddShare(false)} />}

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
                if (window.confirm(`'${s.name}' 공유 폴더를 목록에서 제거할까요? (실제 파일은 지워지지 않습니다)`)) removeShare(s.id)
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
              { label: '폴더 삭제 (PC는 미분류로)', danger: true, onClick: () => saveGroups(deleteFolder(groups, folderMenu.folderId)) },
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
