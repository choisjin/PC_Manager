import { useEffect, useState } from 'react'
import { api, type Artifact, type Transfer } from '../../api'
import type { SubscribeTransfers } from '../../useDashboard'

const MAX = 80

export const kindLabel = (kind: Transfer['kind']) =>
  kind === 'Fetch' ? '가져오기' : kind === 'Compress' ? '압축' : kind === 'Extract' ? '압축 풀기' : '올리기'

/** 진행 중 상태 텍스트 (진행률이 있으면 표시) */
export const pendingText = (transfer: Transfer) => {
  const verb = transfer.kind === 'Compress' ? '압축 중' : transfer.kind === 'Extract' ? '압축 푸는 중' : '전송 중'
  return typeof transfer.percent === 'number' ? `${verb} ${transfer.percent}%` : `${verb}…`
}

function upsert(prev: Transfer[], transfer: Transfer) {
  const existing = prev.find((t) => t.id === transfer.id)
  if (existing && existing.state !== 'Pending' && transfer.state === 'Pending') return prev
  return [transfer, ...prev.filter((t) => t.id !== transfer.id)].slice(0, MAX)
}

/** 모든 PC의 파일 전송(가져오기/올리기/압축)을 모아 추적한다 (Collect 제외). */
export function useTransfers(subscribeTransfers: SubscribeTransfers) {
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [artifactByTransfer, setArtifactByTransfer] = useState<Record<string, Artifact>>({})

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

  return { transfers, artifactByTransfer }
}
