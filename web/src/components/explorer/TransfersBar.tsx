import { useEffect, useState } from 'react'
import { api, type Agent, type Artifact, type Transfer } from '../../api'
import { formatBytes } from '../../format'
import type { SubscribeTransfers } from '../../useDashboard'
import { StateBadge } from '../StateBadge'

interface Props {
  agentById: ReadonlyMap<string, Agent>
  subscribeTransfers: SubscribeTransfers
}

const MAX = 40

const kindLabel = (kind: Transfer['kind']) =>
  kind === 'Fetch' ? '가져오기' : kind === 'Compress' ? '압축' : '올리기'

/** 진행 중 상태 텍스트 (진행률이 있으면 표시) */
const pendingText = (transfer: Transfer) => {
  const verb = transfer.kind === 'Compress' ? '압축 중' : '전송 중'
  return typeof transfer.percent === 'number' ? `${verb} ${transfer.percent}%` : `${verb}…`
}

function upsert(prev: Transfer[], transfer: Transfer) {
  const existing = prev.find((t) => t.id === transfer.id)
  if (existing && existing.state !== 'Pending' && transfer.state === 'Pending') return prev
  return [transfer, ...prev.filter((t) => t.id !== transfer.id)].slice(0, MAX)
}

/** 모든 PC의 파일 전송(가져오기/올리기)을 한곳에 모아 보여주는 하단 바 */
export function TransfersBar({ agentById, subscribeTransfers }: Props) {
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [artifactByTransfer, setArtifactByTransfer] = useState<Record<string, Artifact>>({})
  const [open, setOpen] = useState(true)

  useEffect(() => {
    let active = true
    const resolve = (transfer: Transfer) => {
      if (transfer.kind !== 'Fetch' || transfer.state !== 'Succeeded') return
      api
        .artifacts({ transferId: transfer.id })
        .then((list) => {
          if (active && list[0]) setArtifactByTransfer((prev) => ({ ...prev, [transfer.id]: list[0] }))
        })
        .catch(console.error)
    }

    api
      .transfers({})
      .then((list) => {
        if (!active) return
        const manual = list.filter((t) => t.kind !== 'Collect').slice(0, MAX)
        setTransfers(manual)
        manual.forEach(resolve)
      })
      .catch(console.error)

    const unsubscribe = subscribeTransfers((transfer) => {
      if (transfer.kind === 'Collect') return
      setTransfers((prev) => upsert(prev, transfer))
      resolve(transfer)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [subscribeTransfers])

  const active = transfers.filter((t) => t.state === 'Pending').length

  return (
    <section className={`panel transfers-bar${open ? ' open' : ''}`}>
      <button type="button" className="transfers-bar-head" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▾' : '▸'} 파일 전송 기록</span>
        <span className="muted small">{active > 0 ? `전송 중 ${active}건` : `${transfers.length}건`}</span>
      </button>
      {open && (
        <ul className="transfer-list">
          {transfers.length === 0 && <li className="placeholder">전송 기록이 없습니다</li>}
          {transfers.map((transfer) => {
            const artifact = artifactByTransfer[transfer.id]
            const machine = agentById.get(transfer.agentId)?.machineName ?? transfer.agentId.slice(0, 8)
            return (
              <li key={transfer.id} className="transfer">
                <StateBadge state={transfer.state} />
                <span className="small">{kindLabel(transfer.kind)}</span>
                <span className="small muted ellipsis">{machine}</span>
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
      )}
    </section>
  )
}
