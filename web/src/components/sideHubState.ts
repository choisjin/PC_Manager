import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatRoom, Org, ResultJob, ResultSchedule, Transfer } from '../api'
import { roomTitle } from '../chatRoom'
import type { NoteEvent } from '../useDashboard'
import { useTopLayer } from '../useTopLayer'
import type { ChatActions } from './ChatPanel'
import { JOB_KIND_LABEL, JOB_STATE_LABEL, openJob, resultJobsLoaded, useResultJobs, useResultSchedules } from './results/resultJobs'
import { type ResultSession, useResults } from './results/resultSessions'

// 채팅·메모·진행상황(파일 전송·결과 확인 불러오기·영상 분석·이미지 찾기·예약 분석): PC Manager·Result 화면은 왼쪽 사이드바 탭(PcTree),
// 사이드바가 없는 화면(State·History·설정)·결과 확인 탭·사이드바를 가린 원격조작 창은 떠 있는 PiP(TransfersPip)로 보여 준다.
// 새 메시지·작업 끝남 알림, 안 읽은 수, 보고 있는 채팅방은 여기 한 곳에서 (App이 한 번 만들어 넘긴다). 화면은 SideHub.tsx

export type HubTab = 'chat' | 'notes' | 'transfers'
export const HUB_TABS: [HubTab, string][] = [['chat', '채팅'], ['notes', '메모'], ['transfers', '진행상황']]
/** 접힌 사이드바의 탭 아이콘 */
export const HUB_ICON: Record<HubTab, string> = { chat: '💬', notes: '📝', transfers: '⏳' }

/** 채팅·메모·진행상황에 쓰는 대시보드 데이터 (App이 넘긴다) */
export interface HubSource {
  transfers: Transfer[]
  machineName: (agentId: string) => string
  userName: (userId: string | null | undefined) => string | null
  org: Org
  selfUserId: string | null
  chatRooms: ChatRoom[]
  chatMessages: Record<string, ChatMessage[]>
  chatActions: ChatActions
  subscribeChat: (listener: (message: ChatMessage) => void) => () => void
  subscribeNotes: (listener: (event: NoteEvent) => void) => () => void
}

/**
 * 보여 달라는 요청 (seq가 바뀔 때마다 한 번): user = 사용자가 한 일(알림을 누름·결과 확인을 불러옴) — 사이드바도 그 탭으로 바꾸고 펼친다,
 * auto = 영상 분석·이미지 찾기가 시작·끝남 — 떠 있는 PiP만 펼치고, 사이드바는 탭 배지로 알린다 (보던 PC 목록을 바꾸지 않게)
 */
export interface HubReveal {
  tab: HubTab
  reason: 'user' | 'auto'
  seq: number
}

export interface SideHub extends HubSource {
  activeRoomId: string | null
  changeRoom: (roomId: string | null) => void
  /** 안 읽은 메시지 · 진행 중(전송·결과 불러오기·분석) · 열어 볼 것(준비된 결과 확인·끝난 분석) */
  unread: number
  busy: number
  fresh: number
  /** 창에 포커스가 있고 보인다 (채팅 읽음 처리) */
  focused: boolean
  reveal: HubReveal | null
  /** PiP·사이드바가 지금 채팅을 펼쳐 보여 주는지 알린다 (그 방을 보고 있으면 새 메시지를 알리지 않는다) */
  setChatShown: (key: string, shown: boolean) => void
  activeList: Transfer[]
  recent: Transfer[]
  sessions: ResultSession[]
  jobs: ResultJob[]
  schedules: ResultSchedule[]
}

export const SideHubContext = createContext<SideHub | null>(null)
/** App이 넘긴 채팅·메모·진행상황 (없으면 null: 사이드바에 탭을 그리지 않는다) */
export const useSideHub = () => useContext(SideHubContext)

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

const readKey = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * 채팅·메모·진행상황 상태와 알림 (App에서 한 번). active가 아니면(원격조작·메모 탭) 알림·탭 제목은 건드리지 않는다
 */
export function useSideHubState(source: HubSource, active: boolean): SideHub {
  const { transfers, userName, selfUserId, chatRooms, subscribeChat } = source
  const titleTimerRef = useRef<number>(0)
  const baseTitleRef = useRef(document.title)
  const [reveal, setReveal] = useState<HubReveal | null>(null)
  // 같은 그리기 안에 요청이 둘 이상이면 사용자가 한 일(user)을 남긴다 (뒤의 auto가 덮으면 사이드바는 auto를 무시해 user도 사라진다)
  const shownSeqRef = useRef(0)
  shownSeqRef.current = reveal?.seq ?? 0
  const show = (tab: HubTab, reason: HubReveal['reason']) => setReveal((r) => (
    r && r.seq > shownSeqRef.current && r.reason === 'user' && reason === 'auto' ? r : { tab, reason, seq: (r?.seq ?? 0) + 1 }
  ))

  // 지금 보고 있는 채팅방 (사용자별로 기억)
  const roomKey = `pcm.chat.room.${selfUserId ?? 'anon'}`
  const [activeRoomId, setActiveRoomId] = useState<string | null>(() => readKey(roomKey))
  useEffect(() => {
    setActiveRoomId(readKey(roomKey))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfUserId])
  const changeRoom = useCallback((roomId: string | null) => {
    setActiveRoomId(roomId)
    try {
      if (roomId) localStorage.setItem(roomKey, roomId)
      else localStorage.removeItem(roomKey)
    } catch {
      // 무시
    }
  }, [roomKey])

  // 알림 구독은 한 번만 걸리므로 이름 찾기·나·보는 방·방 바꾸기는 항상 최신 값을 쓰도록 ref로
  const userNameRef = useRef(userName)
  userNameRef.current = userName
  const nameOf = (id: string | null | undefined) => (id ? userNameRef.current(id) ?? '(삭제된 사용자)' : '')
  const stateRef = useRef({ chatRooms, activeRoomId, selfUserId, changeRoom })
  stateRef.current = { chatRooms, activeRoomId, selfUserId, changeRoom }

  // 창이 뒤에 있거나 그 방을 안 보고 있을 때: 윈도우 알림([방 이름] 보낸 사람: 내용) + 탭 제목 깜빡임 + 알림음
  const notify = (m: ChatMessage, room: ChatRoom | undefined, mentioned: boolean) => {
    const title = room ? roomTitle(room, stateRef.current.selfUserId, (id) => nameOf(id)) : '채팅'
    const who = nameOf(m.userId)
    const body = m.text.length > 120 ? m.text.slice(0, 120) + '…' : m.text
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const head = room && room.kind !== 'direct' ? `[${title}] ${who}${mentioned ? '님이 나를 호출했습니다' : ''}` : `${who}${mentioned ? '님이 나를 호출했습니다' : ''}`
        const n = new Notification(head, { body, tag: `pcm-chat-${m.roomId}`, silent: true })
        n.onclick = () => {
          window.focus()
          stateRef.current.changeRoom(m.roomId)
          show('chat', 'user')
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
  /** 작업이 끝남: 윈도우 알림(누르면 결과를 연다) + 알림음 (대시보드·결과 확인 탭이 함께 띄워도 같은 tag라 하나만) */
  const notifyJob = (j: ResultJob) => {
    const what = `${JOB_KIND_LABEL[j.kind]} ${JOB_STATE_LABEL[j.state]}`
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(`${what} · ${j.title}`, { body: j.error ?? j.machineName ?? '', tag: `pcm-job-${j.id}`, silent: true })
        n.onclick = () => {
          window.focus()
          openJob(j)
          n.close()
        }
      } catch {
        // 알림 못 띄우면 무시
      }
    }
    beep()
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

  const activeList = transfers.filter((t) => t.state === 'Pending')
  const recent = transfers.filter((t) => t.state !== 'Pending').slice(0, 5)

  // 결과 확인 불러오기: 진행상황 탭에 함께. 새로 시작하면 보여 준다
  const { sessions } = useResults()
  const loadingCount = sessions.filter((s) => s.state === 'loading').length
  const freshReady = sessions.filter((s) => s.state === 'ready' && !s.opened).length
  const sessionCount = useRef(sessions.length)
  useEffect(() => {
    if (sessions.length > sessionCount.current) show('transfers', 'user')
    sessionCount.current = sessions.length
  }, [sessions.length])

  // 결과 확인 작업(영상 분석·이미지 찾기): 내가 시작한 것만. 새로 시작하거나 끝나면 보여 주고, 끝나면 윈도우 알림
  const allJobs = useResultJobs()
  const jobs = allJobs.filter((j) => !selfUserId || !j.userId || j.userId === selfUserId)
  const runningJobs = jobs.filter((j) => j.state === 'running').length
  const freshJobs = jobs.filter((j) => j.state === 'done' && !j.seen).length
  // 예약 분석: 내가 예약한 것 (대기 중 · 시작 못 함)
  const schedules = useResultSchedules().filter((s) => s.state !== 'started' && (!selfUserId || !s.userId || s.userId === selfUserId))
  const jobStatesRef = useRef<Map<string, ResultJob['state']> | null>(null)
  useEffect(() => {
    // 서버에서 처음 받은 목록은 알리지 않는다
    if (!resultJobsLoaded()) return
    const prev = jobStatesRef.current
    jobStatesRef.current = new Map(jobs.map((j) => [j.id, j.state]))
    if (!prev) return
    const ended = jobs.filter((j) => prev.get(j.id) === 'running' && j.state !== 'running')
    if (ended.length || jobs.some((j) => !prev.has(j.id))) show('transfers', 'auto')
    if (active) for (const j of ended) notifyJob(j)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allJobs])

  // 안 읽은 메시지 합계 → 채팅 탭 배지·브라우저 탭 제목
  const unread = chatRooms.reduce((sum, r) => sum + r.unread, 0)
  useEffect(() => {
    if (!active) return
    baseTitleRef.current = unread > 0 ? `(💬${unread}) RemoteKit` : 'RemoteKit'
    if (!titleTimerRef.current) document.title = baseTitleRef.current
  }, [unread, active])

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
  // 채팅을 펼쳐 보여 주는 곳 (PiP·사이드바)
  const shownRef = useRef(new Set<string>())
  const setChatShown = useCallback((key: string, shown: boolean) => {
    if (shown) shownRef.current.add(key)
    else shownRef.current.delete(key)
  }, [])
  useEffect(() => {
    if (!active) return
    return subscribeChat((m) => {
      const st = stateRef.current
      if (!m.userId || m.userId === st.selfUserId) return
      const away = document.hidden || !document.hasFocus()
      const watching = shownRef.current.size > 0 && st.activeRoomId === m.roomId
      const mentioned = !!st.selfUserId && (m.mentions ?? []).includes(st.selfUserId)
      if (away || !watching) notify(m, st.chatRooms.find((r) => r.id === m.roomId), mentioned)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribeChat, active])

  return {
    ...source,
    activeRoomId,
    changeRoom,
    unread,
    busy: activeList.length + loadingCount + runningJobs,
    fresh: freshReady + freshJobs,
    focused,
    reveal,
    setChatShown,
    activeList,
    recent,
    sessions,
    jobs,
    schedules,
  }
}

/**
 * 사이드바가 가려졌는지: 원격조작 창·전체 화면(브라우저 최상위 층) 또는 대시보드 안 결과 확인 전체 화면(body.rv-open).
 * 가려졌으면 사이드바 대신 PiP가 그 위에 뜬다
 */
export function useSidebarCovered(): boolean {
  const layer = useTopLayer()
  const [viewer, setViewer] = useState(() => document.body.classList.contains('rv-open'))
  useEffect(() => {
    const update = () => setViewer(document.body.classList.contains('rv-open'))
    const observer = new MutationObserver(update)
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    update()
    return () => observer.disconnect()
  }, [])
  return layer !== document.body || viewer
}

/** 이 화면(PiP·사이드바)이 붙은 뒤 새로 온 보여 달라는 요청만 받는다 (붙기 전 것은 무시) */
export function useHubReveal(hub: SideHub | null, accept: (reveal: HubReveal) => void) {
  const seen = useRef(hub?.reveal?.seq ?? 0)
  const seq = hub?.reveal?.seq ?? 0
  useEffect(() => {
    const r = hub?.reveal
    if (!r || r.seq <= seen.current) return
    seen.current = r.seq
    accept(r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq])
}

/** 이 화면이 채팅을 펼쳐 보여 주는지 알린다 (닫히면 거둔다) */
export function useReportChatShown(hub: SideHub | null, key: string, shown: boolean) {
  const setChatShown = hub?.setChatShown
  useEffect(() => {
    if (!setChatShown) return
    setChatShown(key, shown)
    return () => setChatShown(key, false)
  }, [setChatShown, key, shown])
}
