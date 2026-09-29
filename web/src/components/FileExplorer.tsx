import { useMemo, useState } from 'react'
import type { Agent, PcGroups } from '../api'
import type { SubscribeTransfers } from '../useDashboard'
import { ExplorerPane, type Pane } from './explorer/ExplorerPane'
import { PcTree } from './explorer/PcTree'
import { AGENT_MIME, newId } from './explorer/pcGroups'
import { TransfersBar } from './explorer/TransfersBar'

interface Props {
  agents: Agent[]
  pcGroups: PcGroups
  saveGroups: (groups: PcGroups) => void
  subscribeTransfers: SubscribeTransfers
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
const COLUMNS_KEY = 'pcm.explorer.columns'

export function FileExplorer({ agents, pcGroups, saveGroups, subscribeTransfers }: Props) {
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  const [collapsed, setCollapsed] = useState(() => loadLocal(COLLAPSE_KEY, false))
  const [panes, setPanes] = useState<Pane[]>(() => loadLocal<Pane[]>(PANES_KEY, []))
  const [columns, setColumns] = useState(() => loadLocal(COLUMNS_KEY, 2))
  const [dropActive, setDropActive] = useState(false)

  const update = <T,>(setter: (v: T) => void, key: string, value: T) => {
    setter(value)
    saveLocal(key, value)
  }

  const addPane = (agentId: string) =>
    update(setPanes, PANES_KEY, [...panes, { paneId: newId(), agentId }])

  const closePane = (paneId: string) =>
    update(setPanes, PANES_KEY, panes.filter((p) => p.paneId !== paneId))

  const reorder = (fromPaneId: string, toPaneId: string) => {
    const from = panes.findIndex((p) => p.paneId === fromPaneId)
    const to = panes.findIndex((p) => p.paneId === toPaneId)
    if (from < 0 || to < 0 || from === to) return
    const next = panes.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    update(setPanes, PANES_KEY, next)
  }

  return (
    <div className={`explorer-shell${collapsed ? ' tree-collapsed' : ''}`}>
      <PcTree
        agents={agents}
        groups={pcGroups}
        saveGroups={saveGroups}
        collapsed={collapsed}
        onToggleCollapse={() => update(setCollapsed, COLLAPSE_KEY, !collapsed)}
        onOpenAgent={addPane}
      />

      <div className="explorer-main">
        <div className="workspace-bar">
          <span className="muted small">열린 창 {panes.length}개</span>
          <span className="workspace-cols">
            <span className="muted small">열</span>
            {[1, 2, 3].map((c) => (
              <button
                key={c}
                type="button"
                className={`col-btn${columns === c ? ' active' : ''}`}
                onClick={() => update(setColumns, COLUMNS_KEY, c)}
              >
                {c}
              </button>
            ))}
            {panes.length > 0 && (
              <button type="button" className="link" onClick={() => update(setPanes, PANES_KEY, [])}>
                모두 닫기
              </button>
            )}
          </span>
        </div>

        <div
          className={`workspace-grid${dropActive ? ' drop-active' : ''}`}
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
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
            const agent = agentById.get(pane.agentId)
            return (
              <ExplorerPane
                key={pane.paneId}
                paneId={pane.paneId}
                agentId={pane.agentId}
                machineName={agent?.machineName ?? pane.agentId.slice(0, 8)}
                online={agent?.online ?? false}
                subscribeTransfers={subscribeTransfers}
                onClose={() => closePane(pane.paneId)}
                onReorderDrop={(fromPaneId) => reorder(fromPaneId, pane.paneId)}
              />
            )
          })}
        </div>

        <TransfersBar agentById={agentById} subscribeTransfers={subscribeTransfers} />
      </div>
    </div>
  )
}
