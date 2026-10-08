import * as signalR from '@microsoft/signalr'
import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import {
  api,
  type Agent,
  type ChatMessage,
  type ChatRoom,
  type Note,
  type PcStatus,
  type PcStatuses,
  type PcStatusValue,
  type RemoteUsage,
  type Thumbnail,
  type JobRun,
  type JobState,
  type JobTarget,
  type Org,
  type OutputLine,
  type PcFavorites,
  type PcGroups,
  type Run,
  type RunState,
  type SharedFolder,
  type SharedFolders,
  type Transfer,
  type UpdateStatus,
} from './api'
import { EMPTY_GROUPS } from './components/explorer/pcGroups'
import { pcLockStore } from './pcLocks'

/** 메모 변경: 바뀐 메모 / 지운 메모 id / 다시 연결됨(목록 새로 불러오기) */
export type NoteEvent = { note?: Note; removedId?: string; reconnected?: boolean }

export interface OrgActions {
  createProject: (name: string) => Promise<void>
  renameProject: (id: string, name: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  setProjectUsers: (id: string, userIds: string[]) => Promise<void>
  createUser: (name: string) => Promise<void>
  deleteUser: (id: string) => Promise<void>
  setAgentProject: (agentId: string, projectId: string | null) => Promise<void>
  setFolderProject: (folderId: string, projectId: string | null) => Promise<void>
}

export interface RunWatcher {
  onLines: (lines: OutputLine[]) => void
  /** 구독을 시작하거나 재연결한 직후, 놓친 출력을 다시 불러온다 */
  onResync: () => void
}

export type WatchRun = (runId: string, watcher: RunWatcher) => () => void
export type SubscribeTransfers = (listener: (transfer: Transfer) => void) => () => void

const MAX_RUNS = 500
const MAX_JOBS = 200

const byMachineName = (a: Agent, b: Agent) => a.machineName.localeCompare(b.machineName)
const byCreatedDesc = <T extends { createdAt: string }>(a: T, b: T) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt)

function upsertBy<T>(
  items: T[],
  item: T,
  sameKey: (a: T, b: T) => boolean,
  isStale?: (current: T, incoming: T) => boolean,
): T[] {
  const index = items.findIndex((x) => sameKey(x, item))
  if (index < 0) return [...items, item]
  if (isStale?.(items[index], item)) return items
  const next = items.slice()
  next[index] = item
  return next
}

const sameId = <T extends { id: string }>(a: T, b: T) => a.id === b.id

const RUN_STATE_ORDER: Record<RunState, number> = {
  Pending: 0,
  Running: 1,
  Succeeded: 2,
  Failed: 2,
  TimedOut: 2,
  Cancelled: 2,
}

const JOB_STATE_ORDER: Record<JobState, number> = {
  Pending: 0,
  Running: 1,
  Succeeded: 2,
  Failed: 2,
  Cancelled: 2,
}

// POST 응답(대기 상태)이 SignalR로 먼저 받은 진행/종료 상태를 덮어쓰지 않게 한다
const isStaleRun = (current: Run, incoming: Run) =>
  RUN_STATE_ORDER[incoming.state] < RUN_STATE_ORDER[current.state]
const isStaleJob = (current: { state: JobState }, incoming: { state: JobState }) =>
  JOB_STATE_ORDER[incoming.state] < JOB_STATE_ORDER[current.state]

function mergeById<T extends { id: string; createdAt: string }>(
  prev: T[],
  items: T[],
  isStale: (current: T, incoming: T) => boolean,
  max: number,
) {
  let next = prev
  for (const item of items) next = upsertBy(next, item, sameId, isStale)
  return next === prev ? prev : [...next].sort(byCreatedDesc).slice(0, max)
}

/** 대시보드 Hub 연결과 에이전트/실행/Job 상태를 관리한다. */
export function useDashboard() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [jobs, setJobs] = useState<JobRun[]>([])
  const [jobTargets, setJobTargets] = useState<Record<string, JobTarget[]>>({})
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [pcGroups, setPcGroups] = useState<PcGroups>(EMPTY_GROUPS)
  const [favorites, setFavorites] = useState<PcFavorites>({ favorites: {} })
  const [shares, setShares] = useState<SharedFolder[]>([])
  const [org, setOrg] = useState<Org>({ projects: [], users: [], projectUsers: {}, agentProjects: {} })
  const [presence, setPresence] = useState<Record<string, string[]>>({})
  // 대시보드를 열어 둔 사용자 (State 화면)
  const [onlineUsers, setOnlineUsers] = useState<string[]>([])
  const onlineUserRef = useRef<string | null>(null)
  const [pcStatuses, setPcStatuses] = useState<Record<string, PcStatus>>({})
  const [serverHostName, setServerHostName] = useState<string | null>(null)
  const [clientIp, setClientIp] = useState<string | null>(null)
  const [remoteUsage, setRemoteUsage] = useState<RemoteUsage['inUseBy']>({})
  // 채팅방(1:1·그룹)과 방별 메시지 (방을 열 때 불러온다)
  const [chatRooms, setChatRooms] = useState<ChatRoom[]>([])
  const [chatMessages, setChatMessages] = useState<Record<string, ChatMessage[]>>({})
  const chatUserRef = useRef<string | null>(null)
  const chatListenersRef = useRef(new Set<(message: ChatMessage) => void>())
  const noteListenersRef = useRef(new Set<(event: NoteEvent) => void>())
  const [thumbnails, setThumbnails] = useState<Record<string, Thumbnail>>({})
  const thumbWantsRef = useRef<string[]>([])
  const [connected, setConnected] = useState(false)
  const connectionRef = useRef<signalR.HubConnection | null>(null)
  // 재연결 시 다시 알리기 위한 마지막 프레즌스
  const presenceRef = useRef<{ userId: string; agentIds: string[] } | null>(null)
  const watchersRef = useRef(new Map<string, RunWatcher>())
  const transferListenersRef = useRef(new Set<(transfer: Transfer) => void>())
  // 상세를 연 Job: 재연결 시 대상 PC 상태를 다시 불러온다
  const loadedJobIdsRef = useRef(new Set<string>())

  const upsertRuns = useCallback((items: Run[]) => {
    setRuns((prev) => mergeById(prev, items, isStaleRun, MAX_RUNS))
  }, [])

  const upsertJobs = useCallback((items: JobRun[]) => {
    setJobs((prev) => mergeById(prev, items, isStaleJob, MAX_JOBS))
  }, [])

  const upsertTargets = useCallback((jobRunId: string, items: JobTarget[], replace = false) => {
    setJobTargets((prev) => {
      let next = replace ? [] : (prev[jobRunId] ?? [])
      for (const item of items) next = upsertBy(next, item, (a, b) => a.agentId === b.agentId, isStaleJob)
      return { ...prev, [jobRunId]: next }
    })
  }, [])

  useEffect(() => {
    let disposed = false
    const watchers = watchersRef.current
    const transferListeners = transferListenersRef.current
    const loadedJobIds = loadedJobIdsRef.current
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/dashboard')
      .withAutomaticReconnect({ nextRetryDelayInMilliseconds: () => 3000 })
      .configureLogging(signalR.LogLevel.Warning)
      .build()
    connectionRef.current = connection

    connection.on('AgentUpdated', (agent: Agent) =>
      setAgents((prev) => upsertBy(prev, agent, sameId).sort(byMachineName)),
    )
    connection.on('AgentRemoved', (agentId: string) =>
      setAgents((prev) => prev.filter((a) => a.id !== agentId)),
    )
    connection.on('RunUpdated', (run: Run) => upsertRuns([run]))
    connection.on('RunOutput', (runId: string, lines: OutputLine[]) =>
      watchers.get(runId)?.onLines(lines),
    )
    connection.on('JobRunUpdated', (job: JobRun) => upsertJobs([job]))
    connection.on('JobTargetUpdated', (target: JobTarget) => upsertTargets(target.jobRunId, [target]))
    connection.on('TransferUpdated', (transfer: Transfer) => {
      for (const listener of transferListeners) listener(transfer)
    })
    connection.on('UpdateStatusChanged', (status: UpdateStatus) => setUpdateStatus(status))
    connection.on('PcGroupsChanged', (groups: PcGroups) => setPcGroups(groups))
    connection.on('PcFavoritesChanged', (f: PcFavorites) => setFavorites(f))
    // 사용자마다 목록이 달라 서버는 '바뀜'만 알린다 → 내 목록을 다시 불러온다
    connection.on('SharesChanged', () => {
      api.shares().then((s: SharedFolders) => setShares(s.shares)).catch(() => {})
    })
    connection.on('OrgChanged', (o: Org) => setOrg(o))
    connection.on('PresenceChanged', (viewers: Record<string, string[]>) => setPresence(viewers))
    connection.on('OnlineUsersChanged', (ids: string[]) => setOnlineUsers(ids))
    connection.on('PcStatusesChanged', (v: PcStatuses) => setPcStatuses(v.statuses))
    connection.on('RemoteUsageChanged', (v: RemoteUsage) => setRemoteUsage(v.inUseBy))
    // 채팅: 서버는 내가 속한 방의 것만 보낸다
    // 전체 방은 맨 위에 고정, 나머지는 최근 대화 순
    const sortRooms = (list: ChatRoom[]) =>
      [...list].sort(
        (a, b) =>
          Number(b.kind === 'all') - Number(a.kind === 'all') ||
          (b.lastMessage?.at ?? b.createdAt).localeCompare(a.lastMessage?.at ?? a.createdAt),
      )
    connection.on('ChatRoomChanged', (room: ChatRoom) =>
      setChatRooms((prev) => sortRooms([...prev.filter((r) => r.id !== room.id), room])),
    )
    connection.on('ChatRoomRemoved', (roomId: string) => {
      setChatRooms((prev) => prev.filter((r) => r.id !== roomId))
      setChatMessages((prev) => {
        const next = { ...prev }
        delete next[roomId]
        return next
      })
    })
    connection.on('ChatRoomMessage', (m: ChatMessage) => {
      const self = chatUserRef.current
      setChatMessages((prev) => (prev[m.roomId] && !prev[m.roomId].some((x) => x.id === m.id) ? { ...prev, [m.roomId]: [...prev[m.roomId], m].slice(-500) } : prev))
      setChatRooms((prev) =>
        sortRooms(
          prev.map((r) =>
            r.id === m.roomId
              ? { ...r, lastMessage: m, unread: m.userId && m.userId !== self ? r.unread + 1 : r.unread }
              : r,
          ),
        ),
      )
      for (const listener of chatListenersRef.current) listener(m)
    })
    connection.on('ChatRoomRead', (roomId: string, userId: string, messageId: number) => {
      const self = chatUserRef.current
      setChatRooms((prev) =>
        prev.map((r) => {
          if (r.id !== roomId) return r
          const reads = { ...r.reads, [userId]: Math.max(r.reads[userId] ?? 0, messageId) }
          // 내가 (다른 창에서라도) 읽었으면 그 이후 메시지만 안 읽음
          const unread =
            userId === self ? (chatMessagesRef.current[roomId] ?? []).filter((x) => x.id > messageId && x.userId && x.userId !== self).length : r.unread
          return { ...r, reads, unread: userId === self ? Math.min(unread, r.unread) : r.unread }
        }),
      )
    })
    connection.on('ThumbnailUpdated', (t: Thumbnail) => setThumbnails((prev) => ({ ...prev, [t.agentId]: t })))
    // 메모: 공유 메모는 모두, 개인 메모는 내 것만 온다 (메모 화면이 받아 반영)
    connection.on('NoteChanged', (note: Note) => noteListenersRef.current.forEach((l) => l({ note })))
    // PC 잠금: 풀림 여부는 브라우저(쿠키)마다 달라 목록을 다시 받는다
    connection.on('PcLocksChanged', () => void pcLockStore.reload())
    connection.on('NoteRemoved', (id: string) => noteListenersRef.current.forEach((l) => l({ removedId: id })))

    // 연결 직후와 재연결 후: 목록을 새로 받고, 보고 있던 구독을 복구한다
    const sync = async () => {
      const [agentList, runList, jobList, update, groups] = await Promise.all([
        api.agents(),
        api.runs(),
        api.jobs(),
        api.updateStatus().catch(() => null),
        api.pcGroups().catch(() => null),
      ])
      const favs = await api.pcFavorites().catch(() => null)
      const shareList = await api.shares().catch(() => null)
      const orgData = await api.org().catch(() => null)
      const statuses = await api.pcStatuses().catch(() => null)
      const usage = await api.remoteUsage().catch(() => null)
      // 채팅: 이 접속이 받을 사용자를 다시 알리고(재연결 후 그룹 복구) 내 방 목록을 받는다
      if (chatUserRef.current) await connection.invoke('JoinChat', null, chatUserRef.current).catch(() => {})
      const rooms = chatUserRef.current ? await api.chatRooms().catch(() => null) : null
      const install = await api.installInfo().catch(() => null)
      if (disposed) return
      if (install) {
        setServerHostName(install.serverMachineName)
        setClientIp(install.clientIp)
      }
      if (statuses) setPcStatuses(statuses.statuses)
      if (usage) setRemoteUsage(usage.inUseBy)
      if (rooms) setChatRooms(rooms)
      setAgents(agentList.sort(byMachineName))
      setRuns(runList)
      setJobs(jobList)
      if (update) setUpdateStatus(update)
      if (groups) setPcGroups(groups)
      if (favs) setFavorites(favs)
      if (shareList) setShares(shareList.shares)
      if (orgData) setOrg(orgData)
      // 재연결 후 썸네일 구독 복구
      if (thumbWantsRef.current.length > 0)
        connection.invoke('WatchThumbnails', thumbWantsRef.current).catch(() => {})
      // 재연결 후 프레즌스 복구
      if (presenceRef.current)
        connection.invoke('SetPresence', presenceRef.current.userId, presenceRef.current.agentIds).catch(() => {})
      if (onlineUserRef.current) connection.invoke('SetUser', onlineUserRef.current).catch(() => {})
      for (const jobRunId of loadedJobIds) {
        api
          .job(jobRunId)
          .then((detail) => upsertTargets(jobRunId, detail.targets, true))
          .catch(console.error)
      }
      for (const [runId, watcher] of watchers) {
        await connection.invoke('WatchRun', runId)
        watcher.onResync()
      }
    }

    connection.onreconnecting(() => setConnected(false))
    connection.onreconnected(() => {
      setConnected(true)
      sync().catch(console.error)
      noteListenersRef.current.forEach((l) => l({ reconnected: true }))
      void pcLockStore.reload()
    })

    const start = async () => {
      while (!disposed) {
        try {
          await connection.start()
        } catch (err) {
          if (disposed) return
          console.warn('대시보드 Hub 연결 실패, 3초 후 재시도', err)
          await new Promise((resolve) => setTimeout(resolve, 3000))
          continue
        }
        if (disposed) return
        setConnected(true)
        sync().catch(console.error)
        return
      }
    }
    // 개발 모드(StrictMode)의 즉시 언마운트 시 협상 중 중단 에러가 나지 않도록 한 틱 미룬다
    const startTimer = setTimeout(() => void start(), 0)

    return () => {
      disposed = true
      clearTimeout(startTimer)
      connectionRef.current = null
      void connection.stop()
    }
  }, [upsertRuns, upsertJobs, upsertTargets])

  const watchRun = useCallback<WatchRun>((runId, watcher) => {
    watchersRef.current.set(runId, watcher)
    const connection = connectionRef.current
    if (connection?.state === signalR.HubConnectionState.Connected) {
      // 그룹에 먼저 들어간 뒤 기존 출력을 받아야 사이에 온 줄을 놓치지 않는다 (중복은 seq로 제거)
      connection
        .invoke('WatchRun', runId)
        .catch(console.error)
        .finally(() => watcher.onResync())
    } else {
      watcher.onResync()
    }

    return () => {
      if (watchersRef.current.get(runId) === watcher) watchersRef.current.delete(runId)
      const current = connectionRef.current
      if (current?.state === signalR.HubConnectionState.Connected) {
        current.invoke('UnwatchRun', runId).catch(() => {})
      }
    }
  }, [])

  const loadJob = useCallback(
    async (jobRunId: string) => {
      loadedJobIdsRef.current.add(jobRunId)
      const detail = await api.job(jobRunId)
      upsertJobs([detail.job])
      upsertTargets(jobRunId, detail.targets, true)
    },
    [upsertJobs, upsertTargets],
  )

  const subscribeTransfers = useCallback<SubscribeTransfers>((listener) => {
    transferListenersRef.current.add(listener)
    return () => {
      transferListenersRef.current.delete(listener)
    }
  }, [])

  // 낙관적 반영 후 서버 저장 (실패하면 서버 상태로 되돌린다)
  const saveGroups = useCallback((groups: PcGroups) => {
    setPcGroups(groups)
    api.savePcGroups(groups).then(setPcGroups).catch((err) => {
      console.error('PC 그룹 저장 실패', err)
      api.pcGroups().then(setPcGroups).catch(() => {})
    })
  }, [])

  // 즐겨찾기 추가/삭제 (해당 PC 목록만 갱신 후 전체 저장)
  const setAgentFavorites = useCallback((agentId: string, paths: string[]) => {
    setFavorites((prev) => {
      const next: PcFavorites = { favorites: { ...prev.favorites } }
      if (paths.length > 0) next.favorites[agentId] = paths
      else delete next.favorites[agentId]
      api.savePcFavorites(next).then(setFavorites).catch((err) => {
        console.error('즐겨찾기 저장 실패', err)
        api.pcFavorites().then(setFavorites).catch(() => {})
      })
      return next
    })
  }, [])

  // 공유 폴더 등록/삭제 (서버가 SharesChanged로 전체를 다시 알려준다)
  const addShare = useCallback(async (name: string, path: string, username?: string, password?: string) => {
    await api.addShare(name, path, username, password)
    const list = await api.shares().catch(() => null)
    if (list) setShares(list.shares)
  }, [])
  const removeShare = useCallback((id: string) => {
    api.removeShare(id).then((s: SharedFolders) => setShares(s.shares)).catch((err) => console.error('공유 폴더 삭제 실패', err))
  }, [])
  // PC 목록에서 삭제 (연결 끊긴 PC만, 서버가 AgentRemoved로 알려준다). 에이전트가 다시 연결하면 다시 나타남
  const removeAgent = useCallback(async (agentId: string) => {
    await api.removeAgent(agentId)
    setAgents((prev) => prev.filter((a) => a.id !== agentId))
  }, [])
  // 순서 변경: 화면은 바로 바꾸고 서버에 저장 (실패하면 다시 불러옴)
  const reorderShares = useCallback((ids: string[]) => {
    setShares((list) => ids.map((id) => list.find((s) => s.id === id)).filter((s): s is SharedFolder => !!s))
    api.reorderShares(ids).then((s: SharedFolders) => setShares(s.shares)).catch(() => {
      api.shares().then((s: SharedFolders) => setShares(s.shares)).catch(() => {})
    })
  }, [])
  const renameShare = useCallback(async (id: string, name: string) => {
    await api.renameShare(id, name)
    const list = await api.shares().catch(() => null)
    if (list) setShares(list.shares)
  }, [])
  // 사용자를 바꾸면(로그인) 그 사용자의 공유 폴더 목록으로
  const reloadShares = useCallback(() => {
    api.shares().then((s: SharedFolders) => setShares(s.shares)).catch(() => {})
  }, [])

  // 프로젝트/사용자 관리 (서버가 OrgChanged로 다시 알려주지만 응답으로도 즉시 반영)
  const orgActions: OrgActions = {
    createProject: (name: string) => api.createProject(name).then(setOrg),
    renameProject: (id: string, name: string) => api.renameProject(id, name).then(setOrg),
    deleteProject: (id: string) => api.deleteProject(id).then(setOrg),
    setProjectUsers: (id: string, userIds: string[]) => api.setProjectUsers(id, userIds).then(setOrg),
    createUser: (name: string) => api.createUser(name).then(setOrg),
    deleteUser: (id: string) => api.deleteUser(id).then(setOrg),
    setAgentProject: (agentId: string, projectId: string | null) => api.setAgentProject(agentId, projectId).then(setOrg),
    setFolderProject: (folderId: string, projectId: string | null) => api.setFolderProject(folderId, projectId).then(setOrg),
  }

  const setPcStatus = useCallback((agentId: string, status: PcStatusValue, note: string | null) =>
    api.setPcStatus(agentId, status, note).then((v) => setPcStatuses(v.statuses)), [])

  // Remote 화면에서 보고 싶은 PC 목록 (빈 목록 = 구독 해제)
  const watchThumbnails = useCallback((agentIds: string[]) => {
    thumbWantsRef.current = agentIds
    connectionRef.current?.invoke('WatchThumbnails', agentIds).catch(() => {})
  }, [])

  // ── 채팅 ──
  const chatMessagesRef = useRef(chatMessages)
  chatMessagesRef.current = chatMessages

  /** 이 대시보드의 채팅 사용자 (로그인한 사용자). 바꾸면 그 사용자의 방만 받는다 */
  const joinChat = useCallback((userId: string | null) => {
    const previous = chatUserRef.current
    chatUserRef.current = userId
    setChatRooms([])
    setChatMessages({})
    connectionRef.current?.invoke('JoinChat', previous, userId).catch(() => {})
    if (userId) api.chatRooms().then(setChatRooms).catch(() => {})
  }, [])

  const loadChatMessages = useCallback(async (roomId: string) => {
    const list = await api.chatMessages(roomId)
    setChatMessages((prev) => ({ ...prev, [roomId]: list }))
    return list
  }, [])

  /** 방을 보고 있음: 마지막 메시지까지 읽음 처리 */
  const readChatRoom = useCallback((roomId: string) => {
    const self = chatUserRef.current
    const list = chatMessagesRef.current[roomId] ?? []
    const last = list[list.length - 1]
    setChatRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, unread: 0 } : r)))
    if (!self || !last) return
    setChatRooms((prev) => prev.map((r) => (r.id === roomId && (r.reads[self] ?? 0) < last.id ? { ...r, reads: { ...r.reads, [self]: last.id } } : r)))
    api.readChat(roomId, last.id).catch(() => {})
  }, [])

  const upsertRoom = (room: ChatRoom) =>
    setChatRooms((prev) => (prev.some((r) => r.id === room.id) ? prev.map((r) => (r.id === room.id ? room : r)) : [room, ...prev]))

  const chatActions = useMemo(
    () => ({
      load: loadChatMessages,
      read: readChatRoom,
      send: (roomId: string, text: string, mentions: string[]) => api.sendChat(roomId, text, mentions),
      createGroup: async (name: string, memberIds: string[]) => {
        const room = await api.createChatGroup(name, memberIds)
        upsertRoom(room)
        return room
      },
      openDirect: async (userId: string) => {
        const room = await api.openDirectChat(userId)
        upsertRoom(room)
        return room
      },
      invite: async (roomId: string, userIds: string[]) => upsertRoom(await api.inviteChat(roomId, userIds)),
      kick: async (roomId: string, userId: string) => upsertRoom(await api.kickChat(roomId, userId)),
      leave: async (roomId: string) => {
        await api.leaveChat(roomId)
        setChatRooms((prev) => prev.filter((r) => r.id !== roomId))
      },
      rename: async (roomId: string, name: string) => upsertRoom(await api.renameChat(roomId, name)),
    }),
    [loadChatMessages, readChatRoom],
  )

  /** 새 채팅 메시지 알림 받기 (알림 표시용) */
  const subscribeChat = useCallback((listener: (message: ChatMessage) => void) => {
    chatListenersRef.current.add(listener)
    return () => {
      chatListenersRef.current.delete(listener)
    }
  }, [])

  /** 메모 변경 알림 받기 (재연결하면 { reconnected: true } → 목록을 다시 불러온다) */
  const subscribeNotes = useCallback((listener: (event: NoteEvent) => void) => {
    noteListenersRef.current.add(listener)
    return () => {
      noteListenersRef.current.delete(listener)
    }
  }, [])

  /** 이 대시보드의 사용자를 서버에 알린다 (탭과 상관없이 접속 중으로 보이게) */
  const announceUser = useCallback((userId: string | null) => {
    onlineUserRef.current = userId
    if (userId) connectionRef.current?.invoke('SetUser', userId).catch(() => {})
  }, [])

  const announcePresence = useCallback((userId: string, agentIds: string[]) => {
    presenceRef.current = { userId, agentIds }
    connectionRef.current?.invoke('SetPresence', userId, agentIds).catch(() => {})
  }, [])

  return {
    agents,
    runs,
    jobs,
    jobTargets,
    updateStatus,
    pcGroups,
    saveGroups,
    favorites,
    setAgentFavorites,
    shares,
    addShare,
    removeShare,
    renameShare,
    reorderShares,
    removeAgent,
    reloadShares,
    org,
    orgActions,
    presence,
    announcePresence,
    announceUser,
    onlineUsers,
    pcStatuses,
    setPcStatus,
    serverHostName,
    clientIp,
    remoteUsage,
    chatRooms,
    chatMessages,
    chatActions,
    joinChat,
    subscribeChat,
    subscribeNotes,
    thumbnails,
    watchThumbnails,
    connected,
    watchRun,
    upsertRuns,
    upsertJobs,
    upsertTargets,
    loadJob,
    subscribeTransfers,
  }
}
