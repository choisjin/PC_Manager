import * as signalR from '@microsoft/signalr'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  type Agent,
  type JobRun,
  type JobState,
  type JobTarget,
  type OutputLine,
  type Run,
  type RunState,
  type Transfer,
} from './api'

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
  const [connected, setConnected] = useState(false)
  const connectionRef = useRef<signalR.HubConnection | null>(null)
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
    connection.on('RunUpdated', (run: Run) => upsertRuns([run]))
    connection.on('RunOutput', (runId: string, lines: OutputLine[]) =>
      watchers.get(runId)?.onLines(lines),
    )
    connection.on('JobRunUpdated', (job: JobRun) => upsertJobs([job]))
    connection.on('JobTargetUpdated', (target: JobTarget) => upsertTargets(target.jobRunId, [target]))
    connection.on('TransferUpdated', (transfer: Transfer) => {
      for (const listener of transferListeners) listener(transfer)
    })

    // 연결 직후와 재연결 후: 목록을 새로 받고, 보고 있던 구독을 복구한다
    const sync = async () => {
      const [agentList, runList, jobList] = await Promise.all([api.agents(), api.runs(), api.jobs()])
      if (disposed) return
      setAgents(agentList.sort(byMachineName))
      setRuns(runList)
      setJobs(jobList)
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

  return {
    agents,
    runs,
    jobs,
    jobTargets,
    connected,
    watchRun,
    upsertRuns,
    upsertJobs,
    upsertTargets,
    loadJob,
    subscribeTransfers,
  }
}
