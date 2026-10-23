import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type DeviceEntry, type PcSystemInfo, type PerfSample, type ProcessEntry } from '../../api'
import { formatDuration } from '../../format'

export type InfoTab = 'system' | 'disk' | 'processes' | 'performance' | 'devices'

export const INFO_TABS: { id: InfoTab; label: string }[] = [
  { id: 'system', label: '시스템' },
  { id: 'disk', label: '디스크' },
  { id: 'processes', label: '프로세스' },
  { id: 'performance', label: '성능' },
  { id: 'devices', label: '장치' },
]

/** 성능 그래프 길이 (1초마다 → 60초) */
export const PERF_POINTS = 60
const PROCESS_INTERVAL = 2000
const PERF_INTERVAL = 1000
// 시스템·디스크는 거의 안 바뀐다
const SYSTEM_INTERVAL = 30_000

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

function useDocumentVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

/** 끝나면 interval 뒤 다시 (요청이 겹치지 않게). interval이 0이면 한 번만 */
function usePoll(enabled: boolean, interval: number, run: () => Promise<void>, deps: readonly unknown[]) {
  useEffect(() => {
    if (!enabled) return
    let stop = false
    let timer = 0
    const tick = async () => {
      await run()
      if (!stop && interval > 0) timer = window.setTimeout(() => void tick(), interval)
    }
    void tick()
    return () => {
      stop = true
      window.clearTimeout(timer)
    }
    // run은 deps로 대신한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, interval, ...deps])
}

interface Data {
  /** 이 데이터가 어느 PC 것인지 (PC를 바꾸면 다른 PC 것은 안 보인다) */
  agentId: string | null
  system: PcSystemInfo | null
  /** 시스템 정보를 받은 시각 (가동 시간 계산) */
  systemAt: number
  processes: ProcessEntry[] | null
  samples: PerfSample[]
  devices: DeviceEntry[] | null
  errors: Partial<Record<InfoTab, string>>
}

const empty = (agentId: string | null): Data =>
  ({ agentId, system: null, systemAt: 0, processes: null, samples: [], devices: null, errors: {} })

/**
 * PC 정보 패널의 데이터. 보고 있는 탭만, 브라우저 탭이 보일 때만 묻는다
 * (시스템·디스크 30초 · 프로세스 2초 · 성능 1초 · 장치는 열 때와 새로 고침). PC를 바꾸면 그 PC 것만 보인다.
 */
export function usePcInfo(agentId: string | null, tab: InfoTab, active: boolean) {
  const visible = useDocumentVisible()
  const on = active && visible && agentId !== null
  const [stored, setStored] = useState<Data>(() => empty(agentId))
  const [refreshKey, setRefreshKey] = useState(0)
  // 성능: 에이전트 측정 세션과 받은 마지막 번호 (PC를 바꾸면 처음부터)
  const perf = useRef<{ agentId: string | null; session: string | null; seq: number }>({ agentId: null, session: null, seq: 0 })

  /** 응답이 늦게 와 PC가 바뀌었으면 그 PC 것으로 새로 시작 */
  const update = (id: string, change: (d: Data) => Partial<Data>) =>
    setStored((d) => {
      const base = d.agentId === id ? d : empty(id)
      return { ...base, ...change(base) }
    })
  const fail = (id: string, key: InfoTab, err: unknown) => update(id, (d) => ({ errors: { ...d.errors, [key]: toMessage(err) } }))
  const clear = (d: Data, key: InfoTab) => (d.errors[key] === undefined ? d.errors : { ...d.errors, [key]: undefined })

  // 시스템·디스크 탭은 같은 응답
  usePoll(on && (tab === 'system' || tab === 'disk'), SYSTEM_INTERVAL, async () => {
    const id = agentId!
    try {
      const next = await api.pcSystemInfo(id)
      const at = Date.now()
      update(id, (d) => ({ system: next, systemAt: at, errors: clear(d, 'system') }))
    } catch (err) {
      fail(id, 'system', err)
    }
  }, [agentId, refreshKey])

  usePoll(on && tab === 'processes', PROCESS_INTERVAL, async () => {
    const id = agentId!
    try {
      const next = await api.pcProcesses(id)
      update(id, (d) => ({ processes: next.items, errors: clear(d, 'processes') }))
    } catch (err) {
      fail(id, 'processes', err)
    }
  }, [agentId, refreshKey])

  usePoll(on && tab === 'performance', PERF_INTERVAL, async () => {
    const id = agentId!
    const state = perf.current.agentId === id ? perf.current : { agentId: id, session: null, seq: 0 }
    try {
      const next = await api.pcPerformance(id, state.session ? state.seq : 0)
      // 에이전트가 측정을 새로 시작했으면(10초 넘게 안 봤거나 다시 시작) 그래프도 새로
      const fresh = next.session !== state.session
      perf.current = { agentId: id, session: next.session, seq: next.samples.at(-1)?.seq ?? state.seq }
      update(id, (d) => ({
        samples: (fresh ? next.samples : [...d.samples, ...next.samples]).slice(-PERF_POINTS),
        errors: clear(d, 'performance'),
      }))
    } catch (err) {
      fail(id, 'performance', err)
    }
  }, [agentId])

  usePoll(on && tab === 'devices', 0, async () => {
    const id = agentId!
    try {
      const next = await api.pcDevices(id)
      update(id, (d) => ({ devices: next.items, errors: clear(d, 'devices') }))
    } catch (err) {
      fail(id, 'devices', err)
    }
  }, [agentId, refreshKey])

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])
  const data = stored.agentId === agentId ? stored : empty(agentId)
  const error = data.errors[tab === 'disk' ? 'system' : tab] ?? null
  return { system: data.system, systemAt: data.systemAt, processes: data.processes, samples: data.samples, devices: data.devices, error, refresh }
}

export type PcInfoState = ReturnType<typeof usePcInfo>

/** 가동 시간: 하루가 넘으면 "3일 4시간" */
export function formatUptime(ms: number) {
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}일 ${hours % 24}시간`
  return formatDuration(ms)
}

export const formatRate = (bytesPerSecond: number) => `${formatBytesShort(bytesPerSecond)}/s`

function formatBytesShort(bytes: number) {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/** 장치 관리자 문제 코드 → 설명 (자주 나오는 것만, 나머지는 코드만) */
export const PROBLEM_TEXT: Record<number, string> = {
  1: '구성이 잘못됨',
  3: '드라이버가 손상됐거나 메모리가 모자람',
  10: '시작할 수 없음',
  12: '리소스가 모자람',
  14: '다시 시작해야 함',
  18: '드라이버를 다시 설치해야 함',
  19: '레지스트리 정보가 손상됨',
  21: '제거하는 중',
  22: '사용 안 함',
  24: '없거나 제대로 동작하지 않음',
  28: '드라이버 없음',
  31: '드라이버를 불러올 수 없음',
  32: '시작 유형이 사용 안 함',
  37: '드라이버 초기화 실패',
  39: '드라이버가 손상됐거나 없음',
  43: '장치가 문제를 보고함',
  45: '연결되지 않음',
  48: '알려진 문제로 막힘',
  52: '드라이버 서명을 확인할 수 없음',
}
