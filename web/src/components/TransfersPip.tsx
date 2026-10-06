import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTopLayer } from '../useTopLayer'
import type { ChatMessage, ChatRoom, Org, Transfer } from '../api'
import { roomTitle } from '../chatRoom'
import { type ChatActions, ChatPanel } from './ChatPanel'
import { formatBytes } from '../format'
import { kindLabel } from './explorer/useTransfers'

interface Props {
  transfers: Transfer[]
  machineName: (agentId: string) => string
  userName: (userId: string | null | undefined) => string | null
  org: Org
  selfUserId: string | null
  chatRooms: ChatRoom[]
  chatMessages: Record<string, ChatMessage[]>
  chatActions: ChatActions
  subscribeChat: (listener: (message: ChatMessage) => void) => () => void
}

const SIZE_KEY = 'pcm.pip.size2'
const MIN_W = 380
const MIN_H = 220
// 기본 크기: 왼쪽 방 목록 + 오른쪽 대화가 함께 보이게
const DEFAULT_SIZE = { w: 560, h: 420 }

function loadSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    return raw ? (JSON.parse(raw) as { w: number; h: number }) : DEFAULT_SIZE
  } catch {
    return DEFAULT_SIZE
  }
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
export function TransfersPip({ transfers, machineName, userName, org, selfUserId, chatRooms, chatMessages, chatActions, subscribeChat }: Props) {
  const [pos, setPos] = useState(loadPos)
  // 위젯 크기 (오른쪽 아래 모서리를 끌어 조절). null이면 기본
  const [size, setSize] = useState<{ w: number; h: number }>(loadSize)
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
          localStorage.setItem(SIZE_KEY, JSON.stringify(s))
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
  const bodyStyle = { height: size.h - HEAD_H, maxHeight: 'none' as const }
  const [tab, setTab] = useState<PipTab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === 'chat' ? 'chat' : 'transfers'
    } catch {
      return 'transfers'
    }
  })
  const titleTimerRef = useRef<number>(0)
  const baseTitleRef = useRef(document.title)
  // 지금 보고 있는 채팅방 (사용자별로 기억)
  const roomKey = `pcm.chat.room.${selfUserId ?? 'anon'}`
  const [activeRoomId, setActiveRoomId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(roomKey)
    } catch {
      return null
    }
  })
  useEffect(() => {
    try {
      setActiveRoomId(localStorage.getItem(roomKey))
    } catch {
      setActiveRoomId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfUserId])
  const changeRoom = (roomId: string | null) => {
    setActiveRoomId(roomId)
    try {
      if (roomId) localStorage.setItem(roomKey, roomId)
      else localStorage.removeItem(roomKey)
    } catch {
      // 무시
    }
  }

  // 알림 구독은 한 번만 걸리므로 이름 찾기는 항상 최신 사용자 목록을 쓰도록 ref로
  const userNameRef = useRef(userName)
  userNameRef.current = userName
  const nameOf = (id: string | null | undefined) => (id ? userNameRef.current(id) ?? '(삭제된 사용자)' : '')

  // 창이 뒤에 있거나 그 방을 안 보고 있을 때: 윈도우 알림([방 이름] 보낸 사람: 내용) + 탭 제목 깜빡임 + 알림음
  const notify = (m: ChatMessage, room: ChatRoom | undefined, mentioned: boolean) => {
    const title = room ? roomTitle(room, selfUserId, (id) => nameOf(id)) : '채팅'
    const who = nameOf(m.userId)
    const body = m.text.length > 120 ? m.text.slice(0, 120) + '…' : m.text
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const head = room?.kind === 'group' ? `[${title}] ${who}${mentioned ? '님이 나를 호출했습니다' : ''}` : `${who}${mentioned ? '님이 나를 호출했습니다' : ''}`
        const n = new Notification(head, { body, tag: `pcm-chat-${m.roomId}`, silent: true })
        n.onclick = () => {
          window.focus()
          switchTab('chat')
          setCollapsed(false)
          changeRoom(m.roomId)
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
        document.title = on ? (mentioned ? `📣 ${title}` : `💬 ${title}`) : baseTitleRef.current
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

  // 안 읽은 메시지 합계 → 채팅 탭 배지·브라우저 탭 제목
  const unread = chatRooms.reduce((sum, r) => sum + r.unread, 0)
  useEffect(() => {
    baseTitleRef.current = unread > 0 ? `(💬${unread}) RemoteKit` : 'RemoteKit'
    if (!titleTimerRef.current) document.title = baseTitleRef.current
  }, [unread])

  // 새 메시지 알림: 내 메시지·시스템 안내는 빼고, 창이 뒤에 있거나 그 방을 보고 있지 않으면 알린다
  const [focused, setFocused] = useState(() => document.hasFocus() && !document.hidden)
  useEffect(() => {
    const update = () => setFocused(document.hasFocus() && !document.hidden)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  const chatVisible = tab === 'chat' && !collapsed
  const stateRef = useRef({ chatRooms, activeRoomId, chatVisible, selfUserId })
  stateRef.current = { chatRooms, activeRoomId, chatVisible, selfUserId }
  useEffect(
    () =>
      subscribeChat((m) => {
        const st = stateRef.current
        if (!m.userId || m.userId === st.selfUserId) return
        const away = document.hidden || !document.hasFocus()
        const watching = st.chatVisible && st.activeRoomId === m.roomId
        const mentioned = !!st.selfUserId && (m.mentions ?? []).includes(st.selfUserId)
        if (away || !watching) notify(m, st.chatRooms.find((r) => r.id === m.roomId), mentioned)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subscribeChat],
  )

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

  // 원격조작 창·전체 화면처럼 브라우저 최상위 층이 열려 있으면 그 안에 그려야 위에 보인다
  const layer = useTopLayer()

  // 펼치거나 크기·내용이 바뀌어 화면 밖으로 넘치면 전체가 보이게 위치를 당긴다 (창 크기 변경 포함)
  const rootRef = useRef<HTMLDivElement>(null)
  const fitIntoView = () => {
    const el = rootRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // 높이 제한(maxHeight)에 눌리기 전의 원래 높이: 화면에 그려지기 전에 잠깐 제한을 풀고 잰다
    const cap = el.style.maxHeight
    el.style.maxHeight = 'none'
    const needed = el.offsetHeight
    el.style.maxHeight = cap
    setPos((p) => {
      let { x, b } = p
      if (p.b + needed > window.innerHeight - 8) b = Math.max(4, window.innerHeight - 8 - needed)
      if (rect.right > window.innerWidth - 4) x = Math.max(4, x - (rect.right - (window.innerWidth - 4)))
      if (b === p.b && x === p.x) return p
      const next = clampPos({ x, b })
      savePos(next)
      return next
    })
  }
  useLayoutEffect(fitIntoView, [collapsed, tab, size, layer])
  useEffect(() => {
    window.addEventListener('resize', fitIntoView)
    return () => window.removeEventListener('resize', fitIntoView)
  }, [])

  return createPortal(
    <div
      ref={rootRef}
      className={`pip${collapsed ? ' collapsed' : ''}`}
      style={{ left: pos.x, bottom: pos.b, maxHeight: `calc(100vh - ${pos.b + 8}px)`, ...(!collapsed ? { width: size.w } : {}) }}
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
          <ChatPanel
            rooms={chatRooms}
            messages={chatMessages}
            actions={chatActions}
            org={org}
            selfUserId={selfUserId}
            activeRoomId={activeRoomId}
            onActiveRoomChange={changeRoom}
            visible={chatVisible && focused}
          />
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
</div>,
    layer,
  )
}
