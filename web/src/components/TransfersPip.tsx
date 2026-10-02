import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage, OrgUser, Transfer } from '../api'
import { formatBytes } from '../format'
import { kindLabel } from './explorer/useTransfers'

interface Props {
  transfers: Transfer[]
  machineName: (agentId: string) => string
  userName: (userId: string | null | undefined) => string | null
  chat: ChatMessage[]
  users: OrgUser[]
  selfUserId: string | null
  onSendChat: (userId: string, text: string, mentions: string[]) => void
  onMarkRead: (userId: string, messageId: number) => void
}

const SIZE_KEY = 'pcm.pip.size'
const MIN_W = 240
const MIN_H = 180

function loadSize(): { w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    return raw ? (JSON.parse(raw) as { w: number; h: number }) : null
  } catch {
    return null
  }
}

/** 커서 앞의 "@이름" 입력 조각 (드롭다운 표시용) */
const mentionToken = (text: string, caret: number) => {
  const before = text.slice(0, caret)
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before)
  return m ? { query: m[1], start: before.length - m[1].length - 1 } : null
}

/** 텍스트 안의 @이름을 사용자 id로 (이름이 긴 것부터 매칭) */
const findMentions = (text: string, users: OrgUser[]) => {
  const sorted = [...users].sort((a, b) => b.name.length - a.name.length)
  const ids = new Set<string>()
  for (const u of sorted) if (text.includes(`@${u.name}`)) ids.add(u.id)
  return [...ids]
}

/** @이름 부분을 강조해서 렌더 */
const renderText = (text: string, users: OrgUser[]) => {
  const names = [...users].sort((a, b) => b.name.length - a.name.length).map((u) => u.name)
  if (names.length === 0) return text
  const re = new RegExp(`@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g')
  const out: (string | React.JSX.Element)[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(<span key={m.index} className="chat-mention">{m[0]}</span>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** 짧은 알림음 (사용자 조작 이후에만 소리가 난다) */
let audioCtx: AudioContext | null = null
const beep = () => {
  try {
    audioCtx ??= new AudioContext()
    const o = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    o.frequency.value = 880
    g.gain.value = 0.08
    o.connect(g).connect(audioCtx.destination)
    o.start()
    o.stop(audioCtx.currentTime + 0.15)
  } catch {
    // 소리 못 내면 무시
  }
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

// 위치: 왼쪽(x)과 화면 아래에서 위젯 아래 모서리까지의 거리(b).
// 아래 모서리를 고정해 펼치면 위로 늘어나고 접으면 아래로 줄어든다
const POS_KEY = 'pcm.pip.pos2'
const COLLAPSED_KEY = 'pcm.pip.collapsed'

type PipPos = { x: number; b: number }

const clampPos = (p: PipPos): PipPos => ({
  x: Math.max(4, Math.min(window.innerWidth - 60, p.x)),
  b: Math.max(4, Math.min(window.innerHeight - 40, p.b)),
})

function loadPos(): PipPos {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw) return clampPos(JSON.parse(raw) as PipPos)
  } catch {
    // 무시
  }
  return { x: Math.max(12, window.innerWidth - 320), b: 12 }
}

function savePos(p: PipPos) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p))
  } catch {
    // 무시
  }
}

/** 전송 진행률·알림을 띄우는 떠 있는 위젯 (드래그 이동 + 펴고 접기) */
export function TransfersPip({ transfers, machineName, userName, chat, users, selfUserId, onSendChat, onMarkRead }: Props) {
  const [pos, setPos] = useState(loadPos)
  // 위젯 크기 (오른쪽 아래 모서리를 끌어 조절). null이면 기본
  const [size, setSize] = useState<{ w: number; h: number } | null>(loadSize)
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const el = (e.currentTarget as HTMLElement).parentElement as HTMLElement
    const startX = e.clientX
    const startY = e.clientY
    const startW = el.offsetWidth
    const startH = el.offsetHeight
    const startPos = pos
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_W, Math.min(window.innerWidth - 8, startW + ev.clientX - startX))
      // 위로 끌면 커진다 (아래 모서리 고정). 화면 위를 넘지 않게
      const h = Math.max(MIN_H, Math.min(window.innerHeight - startPos.b - 8, startH - (ev.clientY - startY)))
      setSize({ w, h })
      // 오른쪽 화면 끝에 붙어 있으면 넓히는 만큼 왼쪽으로 밀어 준다
      setPos({ x: Math.min(startPos.x, Math.max(4, window.innerWidth - 4 - w)), b: startPos.b })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setSize((s) => {
        try {
          if (s) localStorage.setItem(SIZE_KEY, JSON.stringify(s))
        } catch {
          // 무시
        }
        return s
      })
      setPos((p) => {
        savePos(p)
        return p
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const HEAD_H = 30
  const bodyStyle = size ? { height: size.h - HEAD_H, maxHeight: 'none' as const } : undefined
  const [tab, setTab] = useState<PipTab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === 'chat' ? 'chat' : 'transfers'
    } catch {
      return 'transfers'
    }
  })
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleTimerRef = useRef<number>(0)
  const baseTitleRef = useRef(document.title)

  // 브라우저 알림 권한 (사용자 조작 시점에 요청)
  const askNotify = () => {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
  }

  // 창이 뒤에 있거나 내려가 있을 때: 윈도우 알림 + 탭 제목 깜빡임 + 알림음
  const notify = (m: ChatMessage, mentioned: boolean) => {
    const who = userName(m.userId) ?? '알 수 없음'
    const body = m.text.length > 120 ? m.text.slice(0, 120) + '…' : m.text
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(mentioned ? `${who}님이 나를 호출했습니다` : `${who}의 메시지`, { body, tag: `pcm-chat-${m.id}`, silent: true })
        n.onclick = () => {
          window.focus()
          switchTab('chat')
          n.close()
        }
      } catch {
        // 알림 못 띄우면 무시
      }
    }
    beep()
    if (!titleTimerRef.current) {
      let on = false
      titleTimerRef.current = window.setInterval(() => {
        on = !on
        document.title = on ? (mentioned ? '📣 나를 호출했습니다' : '💬 새 메시지') : baseTitleRef.current
      }, 900)
    }
  }
  const stopTitleFlash = () => {
    if (titleTimerRef.current) {
      clearInterval(titleTimerRef.current)
      titleTimerRef.current = 0
      document.title = baseTitleRef.current
    }
  }
  useEffect(() => {
    const onFocus = () => stopTitleFlash()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      stopTitleFlash()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 채팅 탭을 안 보고 있을 때 새로 온 메시지 수
  const [unread, setUnread] = useState(0)
  // 마지막으로 본/알린 메시지 번호는 사용자별로 브라우저에 기억한다 (새로 열 때 옛 메시지를 다시 알리지 않도록)
  const markKey = (kind: 'seen' | 'notified') => `pcm.chat.${kind}.${selfUserId ?? 'anon'}`
  const loadMark = (kind: 'seen' | 'notified') => {
    try {
      return Number(localStorage.getItem(markKey(kind))) || 0
    } catch {
      return 0
    }
  }
  const saveMark = (kind: 'seen' | 'notified', id: number) => {
    try {
      localStorage.setItem(markKey(kind), String(id))
    } catch {
      // 무시
    }
  }
  const seenRef = useRef<number>(loadMark('seen'))
  const marksForRef = useRef<string | null>(selfUserId)
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

  const isMentionToMe = (m: ChatMessage) => !!selfUserId && m.userId !== selfUserId && (m.mentions ?? []).includes(selfUserId)
  const isUnreadMention = (m: ChatMessage) => isMentionToMe(m) && !(m.readBy ?? []).includes(selfUserId!)
  const unreadMentions = chat.filter(isUnreadMention)
  // 읽음 처리 전까지 탭 제목에 표시 (깜빡임이 끝나도 남는다)
  useEffect(() => {
    baseTitleRef.current = unreadMentions.length > 0 ? `(📣${unreadMentions.length}) Don't Move` : "Don't Move"
    if (!titleTimerRef.current) document.title = baseTitleRef.current
  }, [unreadMentions.length])
  // 새로 열었을 때 읽지 않은 호출이 있으면 다시 알린다 (읽음 처리해야 멈춘다)
  const remindedRef = useRef(false)
  useEffect(() => {
    if (remindedRef.current || chat.length === 0) return
    remindedRef.current = true
    const pending = chat.filter(isUnreadMention)
    if (pending.length > 0) notify(pending[pending.length - 1], true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.length])

  const notifiedRef = useRef<number>(loadMark('notified'))
  useEffect(() => {
    if (chat.length === 0) return
    // 사용자가 바뀌면 그 사용자의 기록으로 다시 읽는다
    if (marksForRef.current !== selfUserId) {
      marksForRef.current = selfUserId
      seenRef.current = loadMark('seen')
      notifiedRef.current = loadMark('notified')
    }
    const last = chat[chat.length - 1]?.id ?? 0
    // 이 브라우저에서 처음 보는 기록(저장된 기준 없음)은 이미 지난 대화로 보고 알리지 않는다
    if (notifiedRef.current === 0) {
      notifiedRef.current = last
      saveMark('notified', last)
      if (seenRef.current === 0) {
        seenRef.current = last
        saveMark('seen', last)
      }
    }
    // 새로 온 남의 메시지: 창이 뒤에 있거나(포커스 없음/숨김) 채팅 탭이 안 보이면 알린다. 나를 호출했으면 항상
    const fresh = chat.filter((m) => m.id > notifiedRef.current && m.userId !== selfUserId)
    if (last > notifiedRef.current) {
      notifiedRef.current = last
      saveMark('notified', last)
    }
    const away = document.hidden || !document.hasFocus()
    const chatVisible = tab === 'chat' && !collapsed
    for (const m of fresh) {
      const mentioned = !!selfUserId && (m.mentions ?? []).includes(selfUserId)
      if (mentioned || away || !chatVisible) notify(m, mentioned)
    }
    if (chatVisible && !away && last > seenRef.current) {
      seenRef.current = last
      saveMark('seen', last)
    }
    // 배지 = 아직 안 본 남의 메시지 + 읽음 처리 안 한 호출
    setUnread(chat.filter((m) => m.userId !== selfUserId && (m.id > seenRef.current || isUnreadMention(m))).length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, tab, collapsed, selfUserId])

  useLayoutEffect(() => {
    const el = chatBodyRef.current
    if (el && tab === 'chat') el.scrollTop = el.scrollHeight
  }, [chat, tab, collapsed])

  const send = () => {
    const text = draft.trim()
    if (!text || !selfUserId) return
    askNotify()
    onSendChat(selfUserId, text, findMentions(text, users))
    setDraft('')
  }

  // @ 드롭다운 후보
  const token = mentionToken(draft, caret)
  const candidates = token ? users.filter((u) => u.name.toLowerCase().includes(token.query.toLowerCase())).slice(0, 8) : []
  const choose = (u: OrgUser) => {
    if (!token) return
    const next = `${draft.slice(0, token.start)}@${u.name} ${draft.slice(caret)}`
    setDraft(next)
    const pos = token.start + u.name.length + 2
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
      setCaret(pos)
    })
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
    const at = (ev: MouseEvent) => clampPos({ x: base.x + ev.clientX - startX, b: base.b - (ev.clientY - startY) })
    const onMove = (ev: MouseEvent) => setPos(at(ev))
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      savePos(at(ev))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={`pip${collapsed ? ' collapsed' : ''}`}
      style={{ left: pos.x, bottom: pos.b, maxHeight: `calc(100vh - ${pos.b + 8}px)`, ...(size && !collapsed ? { width: size.w } : {}) }}
    >
      {!collapsed && <div className="pip-resize" title="드래그해서 크기 조절" onMouseDown={startResize} />}
      <div
        className="pip-head"
        onMouseDown={startDrag}
        onDoubleClick={(e) => {
          // 탭·버튼 더블클릭은 제외
          if ((e.target as HTMLElement).closest('button')) return
          toggleCollapsed()
        }}
        title="끌어서 이동 · 더블클릭으로 펴고 접기"
      >
        <span className="pip-title">
          <span className="pip-grip" aria-hidden="true">⠿</span>
          <span className="pip-tabs" role="tablist" onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'active' : ''} onClick={() => switchTab('chat')}>
              채팅
              {unread > 0 && <span className="pip-count chat">{unread}</span>}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'transfers'} className={tab === 'transfers' ? 'active' : ''} onClick={() => switchTab('transfers')}>
              파일 전송
              {activeList.length > 0 && <span className="pip-count">{activeList.length}</span>}
            </button>
          </span>
        </span>
        <button type="button" className="pip-toggle" title={collapsed ? '펼치기 (위로)' : '접기'} onMouseDown={(e) => e.stopPropagation()} onClick={toggleCollapsed}>
          {collapsed ? '▴' : '▾'}
        </button>
      </div>

      {!collapsed && tab === 'chat' && (
        <div className="pip-body pip-chat" style={bodyStyle}>
          <div className="pip-chat-list" ref={chatBodyRef}>
            {chat.length === 0 && <div className="pip-empty muted small">아직 메시지가 없습니다</div>}
            {chat.map((m) => {
              const mine = m.userId === selfUserId
              return (
                <div key={m.id} className={`chat-msg${mine ? ' mine' : ''}${isMentionToMe(m) ? (isUnreadMention(m) ? ' to-me unread' : ' to-me') : ''}`}>
                  <div className="chat-meta small muted">
                    {mine ? '나' : userName(m.userId) ?? '알 수 없음'} · {timeText(m.at)}
                  </div>
                  <div className="chat-text">{renderText(m.text, users)}</div>
                  {isMentionToMe(m) && (
                    <div className="chat-read small">
                      {isUnreadMention(m) ? (
                        <button type="button" className="chat-read-btn" onClick={() => selfUserId && onMarkRead(selfUserId, m.id)}>
                          읽음 처리
                        </button>
                      ) : (
                        <span className="muted">✓ 읽음</span>
                      )}
                    </div>
                  )}
                  {mine && (m.mentions ?? []).length > 0 && (
                    <div className="chat-read small muted">
                      {(() => {
                        const read = (m.mentions ?? []).filter((id) => (m.readBy ?? []).includes(id)).map((id) => userName(id) ?? '?')
                        const wait = (m.mentions ?? []).filter((id) => !(m.readBy ?? []).includes(id)).map((id) => userName(id) ?? '?')
                        return `${read.length ? `✓ 읽음: ${read.join(', ')}` : ''}${read.length && wait.length ? ' · ' : ''}${wait.length ? `안 읽음: ${wait.join(', ')}` : ''}`
                      })()}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="pip-chat-input">
            {candidates.length > 0 && (
              <ul className="chat-mention-list" role="listbox">
                {candidates.map((u, i) => (
                  <li
                    key={u.id}
                    role="option"
                    aria-selected={i === pick}
                    className={i === pick ? 'active' : ''}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      choose(u)
                    }}
                  >
                    @{u.name}
                  </li>
                ))}
              </ul>
            )}
            <input
              ref={inputRef}
              value={draft}
              placeholder={selfUserId ? '메시지 입력 후 Enter · @이름으로 호출' : '사용자를 선택해야 보낼 수 있습니다'}
              disabled={!selfUserId}
              onFocus={askNotify}
              onChange={(e) => {
                setDraft(e.target.value)
                setCaret(e.target.selectionStart ?? e.target.value.length)
                setPick(0)
              }}
              onSelect={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (candidates.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setPick((p) => (p + 1) % candidates.length)
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setPick((p) => (p - 1 + candidates.length) % candidates.length)
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    choose(candidates[pick] ?? candidates[0])
                    return
                  }
                  if (e.key === 'Escape') {
                    setDraft((d) => d) // 드롭다운은 토큰이 사라져야 닫힌다: 공백 추가
                    return
                  }
                }
                if (e.key === 'Enter') {
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
        <div className="pip-body" style={bodyStyle}>
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
