import { api, type Artifact, type Transfer } from '../api'
import { formatBytes } from '../format'
import { kindLabel, pendingText } from './explorer/useTransfers'
import { StateBadge } from './StateBadge'

interface Props {
  transfers: Transfer[]
  artifactByTransfer: Record<string, Artifact>
  machineName: (agentId: string) => string
  userName: (userId: string | null | undefined) => string | null
}

/** 파일 전송 기록 전용 페이지 */
export function TransfersPage({ transfers, artifactByTransfer, machineName, userName }: Props) {
  const active = transfers.filter((t) => t.state === 'Pending').length

  return (
    <section className="panel transfers-page">
      <div className="panel-head">
        <h2>파일 전송 기록</h2>
        <span className="muted small">{active > 0 ? `전송 중 ${active}건 · 총 ${transfers.length}건` : `${transfers.length}건`}</span>
      </div>
      <ul className="transfer-list page">
        {transfers.length === 0 && <li className="placeholder">전송 기록이 없습니다</li>}
        {transfers.map((transfer) => {
          const artifact = artifactByTransfer[transfer.id]
          return (
            <li key={transfer.id} className="transfer page-row">
              <StateBadge state={transfer.state} />
              <span className="small">{kindLabel(transfer.kind)}</span>
              <span className="small muted ellipsis">{machineName(transfer.agentId)}</span>
              <span className="small user-tag ellipsis" title="실행한 사용자">{userName(transfer.startedByUserId) ?? '—'}</span>
              <span className="mono ellipsis" title={transfer.path ?? undefined}>
                {transfer.path}
              </span>
              <span className={`small ellipsis ${transfer.state === 'Failed' ? 'error' : 'muted'}`} title={transfer.error ?? undefined}>
                {transfer.state === 'Succeeded' ? formatBytes(transfer.totalBytes) : transfer.state === 'Failed' ? transfer.error : pendingText(transfer)}
              </span>
              {artifact ? (
                <a className="small" href={api.artifactUrl(artifact.id)} download>
                  다운로드
                </a>
              ) : (
                <span />
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
