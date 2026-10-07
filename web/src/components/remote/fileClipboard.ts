import { useSyncExternalStore } from 'react'
import { api } from '../../api'

/**
 * 원격 PC에서 복사(Ctrl+C)한 파일 목록. 다른 PC의 원격 화면에서 Ctrl+V를 누르면
 * 서버가 원본 PC → 대상 PC로 파일을 복사하고, 대상 PC 클립보드에 넣은 뒤 Ctrl+V를 보낸다.
 * 브라우저 창을 벗어나면(내 PC로 돌아가면) 내 PC 에이전트로 받아 내 PC 클립보드에 넣는다.
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
// 이 PC에서 복사한 파일(붙여넣을 때만 보인다): 마지막으로 본 목록, PC별로 이미 올린 목록
let lastLocalFiles: string | undefined
const localDelivered = new Map<string, string>()
// 내 PC로 받는 중 (원격 창이 여러 개여도 한 번만)
let selfDelivering: string | null = null
const listeners = new Set<() => void>()

const notify = () => listeners.forEach((l) => l())

const newId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`

export const fileClipboard = {
  get: () => current,
  newId,
  set(agentId: string, machineName: string, paths: string[]) {
    current = { id: newId(), agentId, machineName, paths, delivered: new Set([agentId]) }
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
  /**
   * 붙여넣기에서 본 이 PC 파일 목록(서명). 지난번과 다르면 새로 복사한 것 → true.
   * 처음 보는 거면 원격에서 복사한 파일이 없을 때만 새것으로 본다 (원격 복사가 더 최근일 수 있음)
   */
  noteLocalFiles(signature: string) {
    const changed = lastLocalFiles === undefined ? !current : signature !== lastLocalFiles
    lastLocalFiles = signature
    if (changed) fileClipboard.clear()
    return changed
  },
  /** 이 PC 파일을 그 PC에 이미 올려 클립보드에 넣어 두었는지 */
  localDeliveredTo: (agentId: string, signature: string) => localDelivered.get(agentId) === signature,
  markLocalDelivered: (agentId: string, signature: string) => localDelivered.set(agentId, signature),
  /** 그 PC 클립보드가 바뀜 (원격에서 새로 복사) → 이 PC 파일은 다시 올려야 한다 */
  remoteClipboardChanged: (agentId: string) => localDelivered.delete(agentId),

  /**
   * 원격에서 복사한 파일을 내 PC(대시보드를 연 PC)로 받아 내 PC 클립보드에 넣는다.
   * @returns 안내 문구 (아무것도 안 했으면 null)
   */
  async deliverToSelf(selfAgentId: string): Promise<string | null> {
    const clip = current
    if (!clip || clip.delivered.has(selfAgentId) || selfDelivering === clip.id) return null
    selfDelivering = clip.id
    try {
      const folder = await api.prepareClipboard(selfAgentId)
      const paths: string[] = []
      const errors: string[] = []
      for (const path of clip.paths) {
        try {
          const result = await api.crossCopy({ sourceAgentId: clip.agentId, sourcePath: path, destAgentId: selfAgentId, destFolder: folder, move: false })
          if (result.resultPath) paths.push(result.resultPath)
          if (result.error) errors.push(result.error)
        } catch (err) {
          errors.push(`${path.split(/[\\/]/).pop()}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // 받는 동안 다른 걸 복사했으면 내 PC 클립보드를 덮어쓰지 않는다
      if (paths.length === 0 || current !== clip) return errors.length > 0 ? `내 PC로 받지 못했습니다: ${errors[0]}` : null
      await api.setClipboardFiles(selfAgentId, paths)
      clip.delivered.add(selfAgentId)
      return errors.length > 0
        ? `내 PC 클립보드에 ${paths.length}개를 넣었습니다 (실패 ${errors.length}개: ${errors[0]})`
        : `${clip.machineName}에서 복사한 파일 ${paths.length}개를 내 PC 클립보드에 넣었습니다. 내 PC에서 Ctrl+V로 붙여넣으세요.`
    } catch (err) {
      return `내 PC로 받지 못했습니다: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      if (selfDelivering === clip.id) selfDelivering = null
    }
  },
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useFileClipboard = () => useSyncExternalStore(subscribe, fileClipboard.get)
