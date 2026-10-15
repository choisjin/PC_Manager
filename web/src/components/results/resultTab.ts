// 결과 확인을 새 브라우저 탭에서 연다: 대시보드 탭은 열 내용(경로 또는 저장한 셋)을 localStorage에 적어 두고
// ?result=<id>로 새 탭을 띄우고, 새 탭은 그걸 읽어 불러온다 (F5로 다시 열어도 그대로)
import { newId } from '../explorer/pcGroups'
import type { Source } from './resultSessions'

export interface ResultTabRequest {
  /** 경로로 연 것 */
  source?: Source
  /** 저장한 셋으로 연 것 */
  setId?: string
}

const PREFIX = 'pcm.result.'
// 적어 둔 내용은 일주일 뒤 지운다 (그 사이 F5·북마크로 다시 열 수 있다)
const KEEP_MS = 7 * 24 * 3600_000

/** 이 탭이 결과 확인 탭이면 그 id (?result=…), 대시보드면 null */
export const RESULT_TAB_ID: string | null = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('result')

/**
 * 새 탭에서 결과 확인을 연다. 누른 직후(동기)에 불러야 팝업 차단에 걸리지 않는다
 * @returns 새 탭을 열지 못했으면(팝업 차단) false
 */
export function openResultTab(request: ResultTabRequest): boolean {
  const id = newId()
  write(id, request)
  cleanup()
  const url = `${window.location.pathname}?result=${encodeURIComponent(id)}`
  return window.open(url, '_blank') !== null
}

export function readResultTab(id: string): ResultTabRequest | null {
  try {
    const raw = localStorage.getItem(PREFIX + id)
    return raw ? (JSON.parse(raw) as ResultTabRequest) : null
  } catch {
    return null
  }
}

/** 결과 확인 탭에서 다른 결과로 바꿨을 때 (F5로 다시 열면 바뀐 것으로) */
export const updateResultTab = (id: string, request: ResultTabRequest) => write(id, request)

function write(id: string, request: ResultTabRequest) {
  try {
    localStorage.setItem(PREFIX + id, JSON.stringify({ ...request, at: Date.now() }))
  } catch {
    // 저장이 막힌 브라우저: 새 탭이 '열 결과를 찾지 못했습니다'로 안내한다
  }
}

function cleanup() {
  try {
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      const at = (JSON.parse(localStorage.getItem(key) ?? '{}') as { at?: number }).at ?? 0
      if (Date.now() - at > KEEP_MS) stale.push(key)
    }
    stale.forEach((k) => localStorage.removeItem(k))
  } catch {
    // 무시
  }
}
