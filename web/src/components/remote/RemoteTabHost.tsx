import { useEffect, useMemo, useState } from 'react'
import type { Agent, Org, PcGroups, PcStatus, RemoteUsage } from '../../api'
import { displayName } from '../explorer/pcGroups'
import { RemoteModal } from '../explorer/RemoteModal'
import { RemoteContext, type RemoteContextValue } from './RemoteContext'
import { projectAgents, remoteCandidates, remotePcList, remoteSections } from './remotePcs'
import { exposeRemoteTab, updateRemoteTab } from './remoteTab'

interface Props {
  /** 주소(?remote=…)로 처음 열 PC */
  initialAgentId: string
  agents: Agent[]
  pcGroups: PcGroups
  org: Org
  filterProjectId: string | null
  selfUserId: string | null
  pcStatuses: Record<string, PcStatus>
  remoteUsage: RemoteUsage['inUseBy']
  serverHostName: string | null
  clientIp: string | null
  selfPc: string | null
  /** 대시보드를 연 PC(내 PC)의 에이전트 (온라인일 때만) */
  selfAgentId: string | null
}

/**
 * 원격조작 탭 (?remote=…): 대시보드 대신 원격조작 창만 탭 전체로.
 * 대시보드에서 다른 PC를 고르면 새 탭을 열지 않고 이 탭에서 PC를 바꾼다
 */
export function RemoteTabHost({ initialAgentId, agents, pcGroups, org, filterProjectId, selfUserId, pcStatuses, remoteUsage, serverHostName, clientIp, selfPc, selfAgentId }: Props) {
  const [agentId, setAgentId] = useState(initialAgentId)
  const [closed, setClosed] = useState(false)

  useEffect(
    () =>
      exposeRemoteTab((id) => {
        setClosed(false)
        setAgentId(id)
      }),
    [],
  )
  useEffect(() => updateRemoteTab(agentId), [agentId])

  // 빠른 전환 목록: 대시보드 Remote 모드와 같은 PC들
  const remoteContext = useMemo<RemoteContextValue>(() => {
    const candidates = remoteCandidates(projectAgents(agents, org, filterProjectId), serverHostName, selfPc, clientIp)
    const { allSections } = remoteSections(pcGroups, candidates, org, filterProjectId, selfUserId, null)
    return {
      pcs: remotePcList(allSections, pcGroups, pcStatuses, remoteUsage),
      agents,
      userName: (id) => org.users.find((u) => u.id === id)?.name ?? '다른 사용자',
      selfAgentId,
    }
  }, [agents, pcGroups, org, filterProjectId, selfUserId, pcStatuses, remoteUsage, serverHostName, clientIp, selfPc, selfAgentId])

  const agent = agents.find((a) => a.id === agentId)
  const name = agent ? displayName(agent, pcGroups) : agentId.slice(0, 8)
  useEffect(() => {
    document.title = `${name} · 원격조작`
  }, [name])

  if (closed) {
    return (
      <div className="remote-tab-closed">
        <div className="panel remote-tab-box">
          <h2>{name} 원격조작을 닫았습니다</h2>
          <p className="muted small">대시보드에서 다른 PC를 고르면 이 탭에서 열립니다.</p>
          <div className="remote-tab-actions">
            <button type="button" className="primary" onClick={() => setClosed(false)}>다시 연결</button>
            <button type="button" onClick={() => window.close()}>탭 닫기</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <RemoteContext.Provider value={remoteContext}>
      <RemoteModal
        agentId={agentId}
        machineName={name}
        userId={selfUserId}
        tab
        onAgentChange={setAgentId}
        onClose={() => {
          // 스크립트로 연 탭이라 닫힌다. 못 닫으면(주소로 직접 연 탭 등) '다시 연결·탭 닫기' 안내로
          window.close()
          setClosed(true)
        }}
      />
    </RemoteContext.Provider>
  )
}
