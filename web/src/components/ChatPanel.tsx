import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, ChatRoom, Org, OrgUser } from '../api'
import { roomTitle } from '../chatRoom'

export interface ChatActions {
  load: (roomId: string) => Promise<ChatMessage[]>
  read: (roomId: string) => void
  send: (roomId: string, text: string, mentions: string[]) => Promise<ChatMessage>
  createGroup: (name: string, memberIds: string[]) => Promise<ChatRoom>
  openDirect: (userId: string) => Promise<ChatRoom>
  invite: (roomId: string, userIds: string[]) => Promise<void>
  kick: (roomId: string, userId: string) => Promise<void>
  leave: (roomId: string) => Promise<void>
  rename: (roomId: string, name: string) => Promise<void>
}

interface Props {
  rooms: ChatRoom[]
  messages: Record<string, ChatMessage[]>
  actions: ChatActions
  org: Org
  selfUserId: string | null
  /** 지금 보고 있는 방 (알림·읽음 처리에 쓰려고 바깥에서 관리) */
  activeRoomId: string | null
  onActiveRoomChange: (roomId: string | null) => void
  /** 화면에 보이고 창에 포커스가 있음 → 읽음 처리 */
  visible: boolean
}

type Overlay = null | { kind: 'new' } | { kind: 'invite' } | { kind: 'members' }

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

const timeText = (iso: string) => {
  const d = new Date(iso)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 커서 앞의 "@이름" 입력 조각 (드롭다운 표시용) */
const mentionToken = (text: string, caret: number) => {
  const before = text.slice(0, caret)
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before)
  return m ? { query: m[1], start: before.length - m[1].length - 1 } : null
}

/** 텍스트 안의 @이름을 사용자 id로 (이름이 긴 것부터 매칭) */
const findMentions = (text: string, users: OrgUser[]) => {
  const ids = new Set<string>()
  for (const u of [...users].sort((a, b) => b.name.length - a.name.length)) if (text.includes(`@${u.name}`)) ids.add(u.id)
  return [...ids]
}

/** @이름 부분을 강조 */
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

/** 채팅: 왼쪽 방 목록(1:1·그룹), 오른쪽 대화. 그룹은 초대(누구나)·강퇴(방장)·나가기 */
export function ChatPanel({ rooms, messages, actions, org, selfUserId, activeRoomId, onActiveRoomChange, visible }: Props) {
  const users = org.users
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? '(삭제된 사용자)'
  const room = rooms.find((r) => r.id === activeRoomId) ?? null
  const list = room ? messages[room.id] : undefined
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [error, setError] = useState<string | null>(null)

  // 사용자의 프로젝트 이름 (다른 프로젝트 사람과도 대화 가능 — 고를 때 소속을 보여 준다)
  const projectsOf = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const p of org.projects) for (const uid of org.projectUsers[p.id] ?? []) map.set(uid, [...(map.get(uid) ?? []), p.name])
    return map
  }, [org])

  // 방을 열면 메시지를 불러온다
  useEffect(() => {
    if (room && !messages[room.id]) actions.load(room.id).catch((err) => setError(toMessage(err)))
    setOverlay(null)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id])

  // 보고 있으면 읽음 처리 (새 메시지가 와도)
  useEffect(() => {
    if (room && visible && list) actions.read(room.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id, visible, list?.length])

  // 방이 사라지면(강퇴·나가기) 선택 해제
  useEffect(() => {
    if (activeRoomId && !rooms.some((r) => r.id === activeRoomId)) onActiveRoomChange(null)
  }, [rooms, activeRoomId, onActiveRoomChange])

  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [list?.length, room?.id])

  // ── 입력 ──
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const roomUsers = room ? users.filter((u) => room.members.some((m) => m.userId === u.id)) : []
  const token = room?.kind === 'group' ? mentionToken(draft, caret) : null
  const candidates = token ? roomUsers.filter((u) => u.id !== selfUserId && u.name.toLowerCase().includes(token.query.toLowerCase())).slice(0, 8) : []
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
  const send = () => {
    const text = draft.trim()
    if (!text || !room) return
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
    setDraft('')
    actions.send(room.id, text, findMentions(text, roomUsers)).catch((err) => {
      setError(toMessage(err))
      setDraft(text)
    })
  }

  const run = (work: () => Promise<unknown>) => {
    setError(null)
    work().catch((err) => setError(toMessage(err)))
  }

  if (!selfUserId) return <div className="pip-empty muted small">사용자를 선택(로그인)하면 채팅할 수 있습니다</div>

  // 읽지 않은 구성원 수 (내 메시지 옆 숫자)
  const unreadCount = (m: ChatMessage) =>
    room ? room.members.filter((mem) => mem.userId !== m.userId && (room.reads[mem.userId] ?? 0) < m.id).length : 0

  return (
    <div className="chat-panel">
      <aside className="chat-rooms">
        <button type="button" className="chat-new" onClick={() => setOverlay({ kind: 'new' })}>
          ＋ 새 대화
        </button>
        {rooms.length === 0 && <div className="pip-empty muted small">대화가 없습니다</div>}
        {rooms.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`chat-room-item${r.id === activeRoomId ? ' active' : ''}${r.unread > 0 ? ' unread' : ''}`}
            onClick={() => onActiveRoomChange(r.id)}
            title={r.kind === 'group' ? `${roomTitle(r, selfUserId, nameOf)} · ${r.members.length}명` : roomTitle(r, selfUserId, nameOf)}
          >
            <span className="chat-room-icon" aria-hidden="true">{r.kind === 'group' ? '👥' : '👤'}</span>
            <span className="chat-room-text">
              <span className="chat-room-name ellipsis">
                {roomTitle(r, selfUserId, nameOf)}
                {r.kind === 'group' && <span className="muted"> {r.members.length}</span>}
              </span>
              <span className="chat-room-last ellipsis muted">{r.lastMessage ? r.lastMessage.text : ' '}</span>
            </span>
            {r.unread > 0 && <span className="pip-count chat">{r.unread > 99 ? '99+' : r.unread}</span>}
          </button>
        ))}
      </aside>

      <section className="chat-main">
        {!room ? (
          <div className="pip-empty muted small">왼쪽에서 대화를 고르거나 ＋ 새 대화를 시작하세요</div>
        ) : (
          <>
            <div className="chat-main-head">
              <span className="chat-main-title ellipsis" title={roomTitle(room, selfUserId, nameOf)}>
                {room.kind === 'group' ? '👥 ' : '👤 '}
                {roomTitle(room, selfUserId, nameOf)}
              </span>
              {room.kind === 'group' && (
                <>
                  <button type="button" className="chat-head-btn" title="구성원" onClick={() => setOverlay({ kind: 'members' })}>
                    {room.members.length}명
                  </button>
                  <button type="button" className="chat-head-btn" title="초대" onClick={() => setOverlay({ kind: 'invite' })}>
                    초대
                  </button>
                  {room.ownerId === selfUserId && (
                    <button
                      type="button"
                      className="chat-head-btn"
                      title="방 이름 바꾸기"
                      onClick={() => {
                        const name = window.prompt('채팅방 이름', room.name ?? '')
                        if (name?.trim()) run(() => actions.rename(room.id, name.trim()))
                      }}
                    >
                      ✎
                    </button>
                  )}
                  <button
                    type="button"
                    className="chat-head-btn danger"
                    title="나가기"
                    onClick={() => {
                      if (window.confirm(`'${roomTitle(room, selfUserId, nameOf)}' 방에서 나갈까요?`)) run(() => actions.leave(room.id))
                    }}
                  >
                    나가기
                  </button>
                </>
              )}
            </div>

            <div className="pip-chat-list" ref={listRef}>
              {!list && <div className="pip-empty muted small">불러오는 중…</div>}
              {list?.length === 0 && <div className="pip-empty muted small">첫 메시지를 보내 보세요</div>}
              {list?.map((m) => {
                if (!m.userId) return <div key={m.id} className="chat-system small muted">{m.text}</div>
                const mine = m.userId === selfUserId
                const toMe = !mine && (m.mentions ?? []).includes(selfUserId)
                const left = mine ? unreadCount(m) : 0
                return (
                  <div key={m.id} className={`chat-msg${mine ? ' mine' : ''}${toMe ? ' to-me' : ''}`}>
                    <div className="chat-meta small muted">
                      {mine ? '나' : nameOf(m.userId)} · {timeText(m.at)}
                    </div>
                    <div className="chat-text">{renderText(m.text, roomUsers)}</div>
                    {mine && <div className="chat-read small muted">{left > 0 ? (room.kind === 'direct' ? '안 읽음' : `안 읽음 ${left}`) : '읽음'}</div>}
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
                placeholder={room.kind === 'group' ? '메시지 입력 후 Enter · @이름으로 호출' : '메시지 입력 후 Enter'}
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
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <button type="button" className="primary" disabled={!draft.trim()} onClick={send}>
                보내기
              </button>
            </div>
          </>
        )}
        {error && <div className="chat-error small">{error}</div>}

        {overlay?.kind === 'new' && (
          <NewChat
            users={users.filter((u) => u.id !== selfUserId)}
            projectsOf={projectsOf}
            onCancel={() => setOverlay(null)}
            onDirect={(userId) =>
              run(async () => {
                const r = await actions.openDirect(userId)
                onActiveRoomChange(r.id)
                setOverlay(null)
              })
            }
            onGroup={(name, ids) =>
              run(async () => {
                const r = await actions.createGroup(name, ids)
                onActiveRoomChange(r.id)
                setOverlay(null)
              })
            }
          />
        )}
        {overlay?.kind === 'invite' && room && (
          <PickUsers
            title="초대할 사람"
            users={users.filter((u) => !room.members.some((m) => m.userId === u.id))}
            projectsOf={projectsOf}
            confirmLabel="초대"
            onCancel={() => setOverlay(null)}
            onConfirm={(ids) =>
              run(async () => {
                await actions.invite(room.id, ids)
                setOverlay(null)
              })
            }
          />
        )}
        {overlay?.kind === 'members' && room && (
          <div className="chat-overlay">
            <div className="chat-overlay-head">
              <strong>구성원 {room.members.length}명</strong>
              <button type="button" className="icon-mini" onClick={() => setOverlay(null)}>✕</button>
            </div>
            <ul className="chat-pick-list">
              {room.members.map((m) => (
                <li key={m.userId}>
                  <span className="ellipsis">
                    {nameOf(m.userId)}
                    {m.userId === room.ownerId && <span className="chat-owner"> 방장</span>}
                    {m.userId === selfUserId && <span className="muted"> (나)</span>}
                  </span>
                  {room.ownerId === selfUserId && m.userId !== selfUserId && (
                    <button
                      type="button"
                      className="chat-head-btn danger"
                      onClick={() => {
                        if (window.confirm(`${nameOf(m.userId)}님을 내보낼까요?`)) run(() => actions.kick(room.id, m.userId))
                      }}
                    >
                      내보내기
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}

/** 새 대화: 1:1 상대 고르기 또는 그룹(이름 + 구성원) 만들기 */
function NewChat({
  users,
  projectsOf,
  onCancel,
  onDirect,
  onGroup,
}: {
  users: OrgUser[]
  projectsOf: Map<string, string[]>
  onCancel: () => void
  onDirect: (userId: string) => void
  onGroup: (name: string, memberIds: string[]) => void
}) {
  const [mode, setMode] = useState<'direct' | 'group'>('direct')
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const shown = users
    .filter((u) => !query || u.name.toLowerCase().includes(query.toLowerCase()) || (projectsOf.get(u.id) ?? []).some((p) => p.toLowerCase().includes(query.toLowerCase())))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  return (
    <div className="chat-overlay">
      <div className="chat-overlay-head">
        <span className="segmented">
          <button type="button" className={mode === 'direct' ? 'active' : ''} onClick={() => setMode('direct')}>
            1:1 대화
          </button>
          <button type="button" className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>
            그룹 만들기
          </button>
        </span>
        <button type="button" className="icon-mini" onClick={onCancel}>✕</button>
      </div>
      {mode === 'group' && (
        <input className="chat-overlay-input" placeholder="채팅방 이름 (알림에 표시)" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus />
      )}
      <input className="chat-overlay-input" placeholder="이름·프로젝트로 찾기" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus={mode === 'direct'} />
      <ul className="chat-pick-list">
        {shown.length === 0 && <li className="muted small">사용자가 없습니다</li>}
        {shown.map((u) => (
          <li key={u.id}>
            {mode === 'group' ? (
              <label className="chat-pick">
                <input
                  type="checkbox"
                  checked={picked.has(u.id)}
                  onChange={(e) =>
                    setPicked((s) => {
                      const next = new Set(s)
                      if (e.target.checked) next.add(u.id)
                      else next.delete(u.id)
                      return next
                    })
                  }
                />
                <span className="ellipsis">{u.name}</span>
                <span className="chat-proj muted small ellipsis">{(projectsOf.get(u.id) ?? []).join(', ')}</span>
              </label>
            ) : (
              <button type="button" className="chat-pick" onClick={() => onDirect(u.id)}>
                <span className="ellipsis">{u.name}</span>
                <span className="chat-proj muted small ellipsis">{(projectsOf.get(u.id) ?? []).join(', ')}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {mode === 'group' && (
        <div className="chat-overlay-actions">
          <span className="muted small">{picked.size}명 선택</span>
          <button type="button" className="primary" disabled={!name.trim()} onClick={() => onGroup(name.trim(), [...picked])}>
            만들기
          </button>
        </div>
      )}
    </div>
  )
}

/** 사람 여러 명 고르기 (초대) */
function PickUsers({
  title,
  users,
  projectsOf,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string
  users: OrgUser[]
  projectsOf: Map<string, string[]>
  confirmLabel: string
  onCancel: () => void
  onConfirm: (ids: string[]) => void
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const shown = users
    .filter((u) => !query || u.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  return (
    <div className="chat-overlay">
      <div className="chat-overlay-head">
        <strong>{title}</strong>
        <button type="button" className="icon-mini" onClick={onCancel}>✕</button>
      </div>
      <input className="chat-overlay-input" placeholder="이름으로 찾기" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      <ul className="chat-pick-list">
        {shown.length === 0 && <li className="muted small">초대할 사람이 없습니다</li>}
        {shown.map((u) => (
          <li key={u.id}>
            <label className="chat-pick">
              <input
                type="checkbox"
                checked={picked.has(u.id)}
                onChange={(e) =>
                  setPicked((s) => {
                    const next = new Set(s)
                    if (e.target.checked) next.add(u.id)
                    else next.delete(u.id)
                    return next
                  })
                }
              />
              <span className="ellipsis">{u.name}</span>
              <span className="chat-proj muted small ellipsis">{(projectsOf.get(u.id) ?? []).join(', ')}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="chat-overlay-actions">
        <span className="muted small">{picked.size}명 선택</span>
        <button type="button" className="primary" disabled={picked.size === 0} onClick={() => onConfirm([...picked])}>
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}
