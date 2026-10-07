import { useSyncExternalStore } from 'react'
import { api, type PcLock, setLockedHandler } from './api'
import { askPin } from './pinPrompt'

/**
 * PIN으로 잠긴 PC 목록 (+ 이 브라우저가 풀었는지). 잠금 해제는 서버가 PC별 쿠키로 기억하므로
 * 여기서는 목록만 들고, 풀어야 할 때 PIN을 물어 서버에 보낸다.
 */
let locks: Record<string, PcLock> = {}
let nameOf: (agentId: string) => string = (id) => id.slice(0, 8)
const listeners = new Set<() => void>()
// 같은 PC를 동시에 여러 요청이 풀려고 하면 PIN은 한 번만 묻는다
const pending = new Map<string, Promise<boolean>>()

const notify = () => listeners.forEach((l) => l())

export const pcLockStore = {
  get: () => locks,
  isLocked: (agentId: string) => !!locks[agentId],
  /** 잠겼는데 이 브라우저가 아직 안 풀었음 */
  needsPin: (agentId: string) => !!locks[agentId] && !locks[agentId].unlocked,
  setNameResolver(resolver: (agentId: string) => string) {
    nameOf = resolver
  },
  async reload() {
    try {
      const list = await api.pcLocks()
      locks = Object.fromEntries(list.map((l) => [l.agentId, l]))
      notify()
    } catch {
      // 다음에 다시
    }
  },
}

/**
 * 잠긴 PC면 PIN을 물어 푼다. 잠기지 않았거나 이미 풀었으면 바로 true, 취소하면 false.
 * @param force 목록상 풀린 것으로 보여도(쿠키 만료 등) 다시 묻는다
 */
export function ensureUnlocked(agentId: string, force = false): Promise<boolean> {
  if (!force && !pcLockStore.needsPin(agentId)) return Promise.resolve(true)
  const existing = pending.get(agentId)
  if (existing) return existing
  const work = (async () => {
    let error: string | undefined
    for (;;) {
      const pin = await askPin({
        title: `'${nameOf(agentId)}' PIN 입력`,
        message: 'PIN으로 잠긴 PC입니다. 이 브라우저에서 12시간 동안 풀립니다.',
        error,
      })
      if (pin === null) return false
      try {
        await api.unlockPc(agentId, pin)
        await pcLockStore.reload()
        return true
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    }
  })()
  pending.set(agentId, work)
  void work.finally(() => pending.delete(agentId))
  return work
}

// API가 잠긴 PC(423)를 만나면 PIN을 물어 풀고 다시 시도한다 (목록상 풀렸어도 쿠키가 만료됐을 수 있어 다시 묻는다)
setLockedHandler((agentId) => ensureUnlocked(agentId, true))

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const usePcLocks = () => useSyncExternalStore(subscribe, pcLockStore.get)
