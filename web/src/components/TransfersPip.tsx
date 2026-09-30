import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage, Transfer } from '../api'
import { formatBytes } from '../format'
import { kindLabel } from './explorer/useTransfers'

interface Props {
  transfers: Transfer[]
  machineName: (agentId: string) => string
  userName: (userId: string | null | undefined) => string | null
  chat: ChatMessage[]
  selfUserId: string | null
  onSendChat: (userId: string, text: string) => void
}

type PipTab = 'transfers' | 'chat'
const TAB_KEY = 'pcm.pip.tab'

const timeText = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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
export function TransfersPip({ transfers, machineName, userName, chat, selfUserId, onSendChat }: Props) {
  const [pos, setPos] = useState(loadPos)
  const [tab, setTab] = useState<PipTab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === 'chat' ? 'chat' : 'transfers'
    } catch {
      return 'transfers'
    }
  })
  const [draft, setDraft] = useState('')
  // 채팅 탭을 안 보고 있을 때 새로 온 메시지 수
  const [unread, setUnread] = useState(0)
  const seenRef = useRef<number>(chat[chat.length - 1]?.id ?? 0)
  const chatBodyRef = useRef<HTMLDivElement>(null)

  const switchTab = (next: PipTab) => {
    setTab(next)
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch {
      // 무시
    }
  }
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })

  const activeList = transfers.filter((t) => t.state === 'Pending')
  const recent = transfers.filter((t) => t.state !== 'Pending').slice(0, 5)

  useEffect(() => {
    const last = chat[chat.length - 1]?.id ?? 0
    if (last <= seenRef.current) return
    if (tab === 'chat' && !collapsed) {
      seenRef.current = last
      setUnread(0)
    } else {
      setUnread(chat.filter((m) => m.id > seenRef.current && m.userId !== selfUserId).length)
    }
  }, [chat, tab, collapsed, selfUserId])

  useLayoutEffect(() => {
    const el = chatBodyRef.current
    if (el && tab === 'chat') el.scrollTop = el.scrollHeight
  }, [chat, tab, collapsed])

  const send = () => {
    const text = draft.trim()
    if (!text || !selfUserId) return
    onSendChat(selfUserId, text)
    setDraft('')
  }

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
          <span className="pip-tabs" role="tablist" onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" role="tab" aria-selected={tab === 'transfers'} className={tab === 'transfers' ? 'active' : ''} onClick={() => switchTab('transfers')}>
              파일 전송
              {activeList.length > 0 && <span className="pip-count">{activeList.length}</span>}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'active' : ''} onClick={() => switchTab('chat')}>
              채팅
              {unread > 0 && <span className="pip-count chat">{unread}</span>}
            </button>
          </span>
        </span>
        <button type="button" className="pip-toggle" title={collapsed ? '펼치기' : '접기'} onMouseDown={(e) => e.stopPropagation()} onClick={toggleCollapsed}>
          {collapsed ? '▸' : '▾'}
        </button>
      </div>

      {!collapsed && tab === 'chat' && (
        <div className="pip-body pip-chat">
          <div className="pip-chat-list" ref={chatBodyRef}>
            {chat.length === 0 && <div className="pip-empty muted small">아직 메시지가 없습니다</div>}
            {chat.map((m) => {
              const mine = m.userId === selfUserId
              return (
                <div key={m.id} className={`chat-msg${mine ? ' mine' : ''}`}>
                  <div className="chat-meta small muted">
                    {mine ? '나' : userName(m.userId) ?? '알 수 없음'} · {timeText(m.at)}
                  </div>
                  <div className="chat-text">{m.text}</div>
                </div>
              )
            })}
          </div>
          <div className="pip-chat-input">
            <input
              value={draft}
              placeholder={selfUserId ? '메시지 입력 후 Enter' : '사용자를 선택해야 보낼 수 있습니다'}
              disabled={!selfUserId}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <button type="button" className="primary" disabled={!selfUserId || !draft.trim()} onClick={send}>
              보내기
            </button>
          </div>
        </div>
      )}

      {!collapsed && tab === 'transfers' && (
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
