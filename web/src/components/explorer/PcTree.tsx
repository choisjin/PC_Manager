import { useMemo, useState } from 'react'
import type { Agent, PcGroups } from '../../api'
import { addFolder, AGENT_MIME, assignAgent, buildTree, deleteFolder, type FolderNode, renameFolder } from './pcGroups'

interface Props {
  agents: Agent[]
  groups: PcGroups
  saveGroups: (groups: PcGroups) => void
  collapsed: boolean
  onToggleCollapse: () => void
  onOpenAgent: (agentId: string) => void
}

export function PcTree({ agents, groups, saveGroups, collapsed, onToggleCollapse, onOpenAgent }: Props) {
  const { roots, ungrouped } = useMemo(() => buildTree(groups, agents), [groups, agents])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(groups.folders.map((f) => f.id)))
  const [editing, setEditing] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null) // folderId 또는 'root'

  const onlineCount = agents.filter((a) => a.online).length

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

  const renderAgent = (agent: Agent) => (
    <li
      key={agent.id}
      className={`tree-agent${agent.online ? '' : ' offline'}`}
      draggable
      title={`${agent.machineName} — 더블클릭 또는 드래그해서 열기`}
      onDragStart={(e) => {
        e.dataTransfer.setData(AGENT_MIME, agent.id)
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      onDoubleClick={() => onOpenAgent(agent.id)}
    >
      <span className={`dot ${agent.online ? 'on' : 'off'}`} />
      <span className="ellipsis">{agent.machineName}</span>
      <button type="button" className="tree-open" title="열기" onClick={() => onOpenAgent(agent.id)}>
        ＋
      </button>
    </li>
  )

  const renderFolder = (node: FolderNode, depth: number) => {
    const isOpen = expanded.has(node.folder.id)
    const isDrop = dropTarget === node.folder.id
    return (
      <li key={node.folder.id}>
        <div
          className={`tree-folder${isDrop ? ' drop-active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
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
            {node.agents.map(renderAgent)}
          </ul>
        )}
      </li>
    )
  }

  return (
    <aside className="panel pc-tree">
      <div className="panel-head">
        <button type="button" className="icon tree-collapse" title="접기" onClick={onToggleCollapse}>
          ◂
        </button>
        <h2>테스트 PC</h2>
        <span className="head-actions">
          <span className="muted small">{onlineCount}/{agents.length}</span>
          <button type="button" className="small-btn" title="폴더 추가" onClick={() => createFolder(null)}>
            + 폴더
          </button>
        </span>
      </div>

      <ul className="tree-root">
        {roots.map((node) => renderFolder(node, 0))}

        <li>
          <div
            className={`tree-folder ungrouped${dropTarget === 'root' ? ' drop-active' : ''}`}
            onDragOver={(e) => allowAgentDrop(e, 'root')}
            onDragLeave={() => setDropTarget((t) => (t === 'root' ? null : t))}
            onDrop={(e) => handleDropAgent(e, null)}
          >
            <span className="tree-caret">·</span>
            <span className="tree-folder-name muted">미분류 ({ungrouped.length})</span>
          </div>
          <ul className="tree-children">{ungrouped.map(renderAgent)}</ul>
        </li>

        {agents.length === 0 && <li className="placeholder small">등록된 PC가 없습니다</li>}
      </ul>

      <p className="tree-hint small muted">PC를 오른쪽으로 드래그하면 창이 열립니다 · 폴더로 끌어 그룹 지정</p>
    </aside>
  )
}
