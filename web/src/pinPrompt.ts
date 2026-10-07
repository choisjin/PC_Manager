/** PIN 입력 요청 (화면은 PinDialog가 그린다) */
export interface PinRequest {
  title: string
  message?: string
  /** 앞서 틀린 경우 등 */
  error?: string
  /** 새 PIN 정하기: 한 번 더 입력해 확인 */
  confirm?: boolean
}

type Asker = (request: PinRequest) => Promise<string | null>

let asker: Asker | null = null

/** PinDialog가 자신을 등록한다 */
export function registerPinAsker(next: Asker | null) {
  asker = next
}

/** PIN을 묻는다. 취소하면 null */
export function askPin(request: PinRequest): Promise<string | null> {
  if (!asker) return Promise.resolve(window.prompt(`${request.title}\n${request.message ?? ''}`))
  return asker(request)
}

export const PIN_PATTERN = /^\d{4,12}$/
