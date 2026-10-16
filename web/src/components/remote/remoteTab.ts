// 원격조작을 새 브라우저 탭(?remote=<agentId>)에서 연다. 원격 탭은 하나만 쓴다:
// 이미 열려 있으면 새 탭을 만들지 않고 그 탭에서 PC만 바꾼다 (같은 이름의 창을 window.open으로 다시 찾는다)

/** 이 탭이 원격조작 탭이면 처음 열 PC id (?remote=…), 대시보드면 null */
export const REMOTE_TAB_AGENT: string | null = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('remote')

const WINDOW_NAME = 'pcm-remote'

/** 원격 탭이 열어 두는 PC 전환 함수 (같은 출처라 대시보드 탭이 바로 부를 수 있다) */
interface RemoteTabWindow extends Window {
  pcmRemoteSwitch?: (agentId: string) => void
}

const remoteUrl = (agentId: string) => `${window.location.pathname}?remote=${encodeURIComponent(agentId)}`

/**
 * 원격조작 탭을 연다. 이미 열려 있으면 그 탭에서 PC를 바꾸고 앞으로 가져온다.
 * 누른 직후(동기)에 불러야 팝업 차단에 걸리지 않는다
 * @returns 탭을 열지 못했으면(팝업 차단) false
 */
export function openRemoteTab(agentId: string): boolean {
  // 빈 주소로 열면 같은 이름의 탭이 있을 때 그 탭을 그대로 돌려준다 (없으면 빈 새 탭)
  const w = window.open('', WINDOW_NAME) as RemoteTabWindow | null
  if (!w) return false
  try {
    if (typeof w.pcmRemoteSwitch === 'function') {
      w.pcmRemoteSwitch(agentId)
      w.focus()
      return true
    }
  } catch {
    // 읽을 수 없는 탭: 아래처럼 주소로 연다
  }
  // 새로 연 빈 탭, 또는 아직 불러오는 중인 원격 탭: 그 PC 주소로
  w.location.href = remoteUrl(agentId)
  w.focus()
  return true
}

/**
 * 원격 탭: 대시보드가 PC를 바꿀 수 있게 전환 함수를 열어 둔다.
 * 창 이름도 붙여 둬서 F5로 다시 연 탭도 대시보드가 다시 찾는다
 * @returns 정리 함수
 */
export function exposeRemoteTab(onSwitch: (agentId: string) => void): () => void {
  const w = window as RemoteTabWindow
  window.name = WINDOW_NAME
  w.pcmRemoteSwitch = onSwitch
  return () => {
    if (w.pcmRemoteSwitch === onSwitch) delete w.pcmRemoteSwitch
  }
}

/** 원격 탭에서 PC를 바꾸면 주소도 바꾼다 (F5로 다시 열면 그 PC) */
export function updateRemoteTab(agentId: string) {
  window.history.replaceState(null, '', remoteUrl(agentId) + window.location.hash)
}
