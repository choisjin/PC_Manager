import { useEffect, useState } from 'react'
import { type Agent, PC_STATUS_LABEL, type PcStatus, type RemoteUsage, type Thumbnail } from '../api'
import { RemoteModal } from './explorer/RemoteModal'

interface Props {
  agents: Agent[]
  /** 선택한 폴더 이름 (없으면 전체) */
  groupName: string | null
  displayName: (agent: Agent) => string
  thumbnails: Record<string, Thumbnail>
  watchThumbnails: (agentIds: string[]) => void
  pcStatuses: Record<string, PcStatus>
  remoteUsage: RemoteUsage['inUseBy']
  selfUserId: string | null
  userName: (userId: string) => string
}

/** "12분째 움직임 없음" 같은 문구 */
function idleText(seconds: number): string {
  if (seconds < 60) return '움직임 있음'
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}분째 움직임 없음`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}시간${rm ? ` ${rm}분` : ''}째 움직임 없음`
}

/** Remote 모드: 그룹 안 PC들의 화면 미리보기 카드. 클릭하면 원격조작 */
export function RemoteGrid({ agents, groupName, displayName, thumbnails, watchThumbnails, pcStatuses, remoteUsage, selfUserId, userName }: Props) {
  const [remote, setRemote] = useState<Agent | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 보고 있는 PC 목록을 서버에 알린다 (온라인만). 화면을 떠나면 해제
  const onlineKey = agents.filter((a) => a.online).map((a) => a.id).sort().join(',')
  useEffect(() => {
    watchThumbnails(onlineKey ? onlineKey.split(',') : [])
    return () => watchThumbnails([])
  }, [onlineKey, watchThumbnails])

  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(id)
  }, [notice])

  const open = (agent: Agent) => {
    if (!agent.online) return
    const st = pcStatuses[agent.id]
    const by = remoteUsage[agent.id]?.userId
    if (st?.status === 'forbidden') {
      setNotice(`${displayName(agent)}: 사용 금지 상태라 원격조작할 수 없습니다.${st.note ? ` (${st.note})` : ''}`)
      return
    }
    if (by && by !== selfUserId) {
      setNotice(`${displayName(agent)}: ${userName(by)}님이 원격조작 중입니다.`)
      return
    }
    if (st?.status === 'testing' && !window.confirm(`'${displayName(agent)}'은(는) '테스트 중' 상태입니다.${st.note ? ` (${st.note})` : ''}\n그래도 원격조작할까요?`)) return
    setRemote(agent)
  }

  return (
    <div className="remote-grid-wrap">
      <div className="remote-grid-head">
        <span>
          <b>{groupName ?? '전체'}</b> <span className="muted small">· {agents.length}대 (온라인 {agents.filter((a) => a.online).length})</span>
          {!groupName && <span className="muted small"> · 왼쪽에서 폴더를 클릭하면 그 그룹만 표시</span>}
        </span>
        {notice && <span className="remote-grid-notice small">{notice}</span>}
      </div>
      {agents.length === 0 && <div className="muted small remote-grid-empty">이 그룹에 PC가 없습니다. 왼쪽에서 폴더를 선택하세요.</div>}
      <div className="remote-grid">
        {agents.map((agent) => {
          const t = thumbnails[agent.id]
          const st = pcStatuses[agent.id]
          const by = remoteUsage[agent.id]?.userId
          const busy = !!by
          const idle = t ? idleText(t.idleSeconds) : null
          const cls = ['remote-card', agent.online ? '' : 'offline', busy ? 'busy' : '', st?.status === 'forbidden' ? 'forbidden' : ''].filter(Boolean).join(' ')
          return (
            <div key={agent.id} className={cls} onClick={() => open(agent)} title={agent.online ? '클릭하면 원격조작' : '오프라인'}>
              <div className="remote-card-shot">
                {t ? <img src={`data:image/jpeg;base64,${t.jpeg}`} alt="" /> : <div className="remote-card-blank muted small">{agent.online ? '화면 가져오는 중…' : '오프라인'}</div>}
                {busy && <div className="remote-card-overlay">사용 중 · {userName(by)}</div>}
                {!busy && st?.status === 'forbidden' && <div className="remote-card-overlay forbidden">사용 금지</div>}
              </div>
              <div className="remote-card-body">
                <div className="remote-card-title">
                  <span className={`dot ${agent.online ? 'on' : 'off'}`} />
                  <span className="ellipsis">{displayName(agent)}</span>
                  {st && st.status !== 'available' && (
                    <span className={`status-badge ${st.status}`} title={st.note ?? undefined}>{PC_STATUS_LABEL[st.status]}</span>
                  )}
                </div>
                <div className="remote-card-sub small muted ellipsis">
                  {!agent.online ? '오프라인' : idle ?? '…'}
                  {st?.note ? ` · ${st.note}` : ''}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {remote && <RemoteModal agentId={remote.id} machineName={displayName(remote)} userId={selfUserId} onClose={() => setRemote(null)} />}
    </div>
  )
}
