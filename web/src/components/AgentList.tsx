import { useMemo, useState } from 'react'
import type { Agent } from '../api'
import { formatTime } from '../format'

interface Props {
  agents: Agent[]
  selectedIds: ReadonlySet<string>
  onSelectionChange: (ids: Set<string>) => void
}

export function AgentList({ agents, selectedIds, onSelectionChange }: Props) {
  const [filter, setFilter] = useState('')

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!query) return agents
    return agents.filter((a) =>
      [a.machineName, ...a.ipAddresses, ...a.tags].some((v) => v.toLowerCase().includes(query)),
    )
  }, [agents, filter])

  const onlineCount = agents.filter((a) => a.online).length
  const allVisibleSelected = visible.length > 0 && visible.every((a) => selectedIds.has(a.id))

  const toggle = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectionChange(next)
  }

  const toggleVisible = () => {
    const next = new Set(selectedIds)
    for (const agent of visible) {
      if (allVisibleSelected) next.delete(agent.id)
      else next.add(agent.id)
    }
    onSelectionChange(next)
  }

  const selectVisibleOnline = () =>
    onSelectionChange(new Set(visible.filter((a) => a.online).map((a) => a.id)))

  return (
    <aside className="panel agents">
      <div className="panel-head">
        <h2>테스트 PC</h2>
        <span className="muted small">
          {onlineCount} / {agents.length} 온라인
        </span>
      </div>

      <div className="agent-tools">
        <input
          placeholder="이름, IP, 태그 검색"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="check" title="검색 결과 전체 선택">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            disabled={visible.length === 0}
            onChange={toggleVisible}
          />
          전체
        </label>
      </div>

      <ul className="agent-list">
        {agents.length === 0 && <li className="placeholder">연결된 에이전트가 없습니다</li>}
        {agents.length > 0 && visible.length === 0 && (
          <li className="placeholder">검색 결과가 없습니다</li>
        )}
        {visible.map((agent) => (
          <li
            key={agent.id}
            className={`agent${selectedIds.has(agent.id) ? ' selected' : ''}${agent.online ? '' : ' offline'}`}
          >
            <label
              title={`${agent.osVersion}\n에이전트 ${agent.agentVersion} · 실행 계정 ${agent.userName}\nMAC ${agent.macAddresses.join(', ') || '-'}`}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(agent.id)}
                onChange={() => toggle(agent.id)}
              />
              <span className={`dot ${agent.online ? 'on' : 'off'}`} />
              <span className="agent-main">
                <span className="agent-name">{agent.machineName}</span>
                <span className="agent-meta mono">
                  {agent.ipAddresses[0] ?? '-'}
                  {!agent.online && ` · 마지막 접속 ${formatTime(agent.lastSeenAt)}`}
                </span>
                {agent.tags.length > 0 && (
                  <span className="tags">
                    {agent.tags.map((tag) => (
                      <span key={tag} className="tag">
                        {tag}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="agent-footer">
        <span>{selectedIds.size}대 선택됨</span>
        <span>
          <button type="button" className="link" onClick={selectVisibleOnline}>
            온라인만 선택
          </button>
          <button
            type="button"
            className="link"
            disabled={selectedIds.size === 0}
            onClick={() => onSelectionChange(new Set())}
          >
            선택 해제
          </button>
        </span>
      </div>
    </aside>
  )
}
