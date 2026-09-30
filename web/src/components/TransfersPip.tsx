import { useState } from 'react'
import type { Transfer } from '../api'
import { formatBytes } from '../format'
import { kindLabel } from './explorer/useTransfers'

interface Props {
  transfers: Transfer[]
  machineName: (agentId: string) => string
  userName: (userId: string | null | undefined) => string | null
}

const leafOf = (path: string | null) => path?.split(/[\\/]/).filter(Boolean).pop() ?? ''

/** 어디서 → 어디로 (간략) */
const flowText = (t: Transfer, machine: string) => {
  if (t.kind === 'Fetch') return `${machine} → 서버`
  if (t.kind === 'Push') return `서버 → ${machine}`
  return `${machine} 내부` // 압축
}

const POS_KEY = 'pcm.pip.pos'
const COLLAPSED_KEY = 'pcm.pip.collapsed'

function loadPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw) return JSON.parse(raw) as { x: number; y: number }
  } catch {
    // 무시
  }
  return { x: Math.max(12, window.innerWidth - 320), y: Math.max(12, window.innerHeight - 280) }
}

/** 전송 진행률·알림을 띄우는 떠 있는 위젯 (드래그 이동 + 펴고 접기) */
export function TransfersPip({ transfers, machineName, userName }: Props) {
  const [pos, setPos] = useState(loadPos)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })

  const activeList = transfers.filter((t) => t.state === 'Pending')
  const recent = transfers.filter((t) => t.state !== 'Pending').slice(0, 5)

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, v ? '0' : '1')
      } catch {
        // 무시
      }
      return !v
    })
  }

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const base = pos
    const onMove = (ev: MouseEvent) => {
      const x = Math.max(4, Math.min(window.innerWidth - 60, base.x + ev.clientX - startX))
      const y = Math.max(4, Math.min(window.innerHeight - 40, base.y + ev.clientY - startY))
      setPos({ x, y })
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const next = {
        x: Math.max(4, Math.min(window.innerWidth - 60, base.x + ev.clientX - startX)),
        y: Math.max(4, Math.min(window.innerHeight - 40, base.y + ev.clientY - startY)),
      }
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(next))
      } catch {
        // 무시
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className={`pip${collapsed ? ' collapsed' : ''}`} style={{ left: pos.x, top: pos.y }}>
      <div className="pip-head" onMouseDown={startDrag}>
        <span className="pip-title">
          <span className="pip-grip" aria-hidden="true">⠿</span>
          파일 전송
          {activeList.length > 0 && <span className="pip-count">{activeList.length}</span>}
        </span>
        <button type="button" className="pip-toggle" title={collapsed ? '펼치기' : '접기'} onMouseDown={(e) => e.stopPropagation()} onClick={toggleCollapsed}>
          {collapsed ? '▸' : '▾'}
        </button>
      </div>

      {!collapsed && (
        <div className="pip-body">
          {activeList.length === 0 && recent.length === 0 && <div className="pip-empty muted small">전송 없음</div>}

          {activeList.map((t) => {
            const who = userName(t.startedByUserId)
            return (
              <div key={t.id} className="pip-item active" title={t.path ?? undefined}>
                <div className="pip-item-top">
                  <span className="pip-flow small ellipsis">{flowText(t, machineName(t.agentId))}</span>
                  <span className="pip-pct small">{typeof t.percent === 'number' ? `${t.percent}%` : '…'}</span>
                </div>
                <div className="pip-bar">
                  <div className={`pip-bar-fill${typeof t.percent !== 'number' ? ' indet' : ''}`} style={{ width: `${typeof t.percent === 'number' ? t.percent : 100}%` }} />
                </div>
                <div className="pip-sub small muted ellipsis">
                  {kindLabel(t.kind)} · {leafOf(t.path)}{who ? ` · ${who}` : ''}
                </div>
              </div>
            )
          })}

          {recent.length > 0 && (
            <div className="pip-recent">
              <div className="pip-recent-title muted small">최근 알림</div>
              {recent.map((t) => (
                <div key={t.id} className={`pip-note small${t.state === 'Failed' ? ' error' : ''}`} title={t.error ?? t.path ?? undefined}>
                  <span className={`pip-dot ${t.state === 'Failed' ? 'fail' : 'ok'}`} />
                  <span className="ellipsis">
                    {kindLabel(t.kind)} · {t.path?.split(/[\\/]/).pop()}
                  </span>
                  <span className="muted">{t.state === 'Succeeded' ? formatBytes(t.totalBytes) : '실패'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
