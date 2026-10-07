import { useSyncExternalStore } from 'react'

/**
 * 원격 PC에서 복사(Ctrl+C)한 파일 목록. 다른 PC의 원격 화면에서 Ctrl+V를 누르면
 * 서버가 원본 PC → 대상 PC로 파일을 복사하고, 대상 PC 클립보드에 넣은 뒤 Ctrl+V를 보낸다.
 * 원격 창이 여러 개여도 하나를 같이 쓴다 (모듈 상태)
 */
export interface RemoteFileClip {
  id: string
  agentId: string
  machineName: string
  paths: string[]
  /** 이미 받아 둔 PC (그 PC 클립보드에 들어 있으므로 Ctrl+V를 그대로 보낸다) */
  delivered: Set<string>
}

let current: RemoteFileClip | null = null
// 이 PC 클립보드에서 마지막으로 본 텍스트. 바뀌었으면 사용자가 새로 복사한 것 → 파일 클립보드를 비운다
let lastLocalText: string | undefined
const listeners = new Set<() => void>()

const notify = () => listeners.forEach((l) => l())

export const fileClipboard = {
  get: () => current,
  set(agentId: string, machineName: string, paths: string[]) {
    current = { id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`, agentId, machineName, paths, delivered: new Set([agentId]) }
    notify()
  },
  clear() {
    if (!current) return
    current = null
    notify()
  },
  markDelivered(agentId: string) {
    current?.delivered.add(agentId)
  },
  /** 이 PC 클립보드 텍스트를 읽었을 때 / 원격 텍스트를 이 PC 클립보드에 썼을 때 */
  noteLocalText(text: string, readFromLocal: boolean) {
    if (readFromLocal && lastLocalText !== undefined && text !== lastLocalText) fileClipboard.clear()
    lastLocalText = text
  },
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useFileClipboard = () => useSyncExternalStore(subscribe, fileClipboard.get)
