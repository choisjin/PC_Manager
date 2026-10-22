// 대시보드는 HTTPS가 기본: 원격조작 키보드 잠금·WebCodecs·클립보드 등은 브라우저가 HTTPS에서만 허용한다
//
//   HTTP로 열렸고 서버가 HTTPS 주소를 알려 주면, 이 PC가 서버 인증서를 신뢰하는지(HTTPS 요청이 되는지) 보고
//   되면 그 HTTPS 주소로 옮긴다. 로그인·화면 설정(localStorage)은 주소(origin)마다 따로라 주소 # 뒤에 실어 넘긴다.
//   안 되면 HTTP로 열고 안내 띠(httpsBlocked)를 보여 준다. 주소에 ?http 를 붙이면 옮기지 않는다
import type { InstallInfo } from './api'

const MIGRATE = '#pcm-migrate='
/** 넘길 localStorage가 이보다 크면 pcm.* 키(로그인·설정)만 */
const MAX_MIGRATE = 200_000
const TIMEOUT = 2000

/** HTTP에 남은 이유 (안내 띠). HTTPS로 열렸거나 서버가 HTTPS를 안 쓰면 null */
export let httpsBlocked: { httpsUrl: string; installerUrl: string | null } | null = null

/** HTTPS 쪽: HTTP에서 넘겨받은 저장 값을 넣는다 (이미 있는 값은 그대로: HTTPS 쪽이 더 새 것) */
export function importMigrated() {
  if (!location.hash.startsWith(MIGRATE)) return
  try {
    const { hash, data } = JSON.parse(decodeURIComponent(location.hash.slice(MIGRATE.length))) as { hash: string; data: Record<string, string> }
    for (const [key, value] of Object.entries(data)) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value)
    }
    history.replaceState(history.state, '', location.pathname + location.search + (hash || ''))
  } catch {
    history.replaceState(history.state, '', location.pathname + location.search)
  }
}

function storageSnapshot(): Record<string, string> {
  const all: Record<string, string> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key !== null) all[key] = localStorage.getItem(key) ?? ''
    }
  } catch {
    return {}
  }
  if (JSON.stringify(all).length <= MAX_MIGRATE) return all
  return Object.fromEntries(Object.entries(all).filter(([key, value]) => key.startsWith('pcm.') && value.length < 10_000))
}

/** HTTPS 주소로 요청이 되는지 (인증서를 신뢰하지 않으면 브라우저가 막아 실패한다) */
async function reachable(origin: string) {
  try {
    await fetch(`${origin}/api/install/info`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT) })
    return true
  } catch {
    return false
  }
}

/** HTTP로 열렸으면 되는 대로 HTTPS로 옮긴다. 옮기는 중이면 true (화면을 그리지 않는다) */
export async function upgradeToHttps(): Promise<boolean> {
  if (location.protocol !== 'http:' || import.meta.env.DEV) return false
  if (new URLSearchParams(location.search).has('http')) return false
  let info: InstallInfo
  try {
    const res = await fetch('/api/install/info', { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return false
    info = (await res.json()) as InstallInfo
  } catch {
    return false
  }
  let target: URL
  try {
    target = new URL(info.httpsUrl ?? '')
  } catch {
    return false
  }
  if (target.protocol !== 'https:') return false
  if (!(await reachable(target.origin))) {
    httpsBlocked = { httpsUrl: target.origin, installerUrl: info.certificateInstallerUrl }
    return false
  }
  const payload = JSON.stringify({ hash: location.hash, data: storageSnapshot() })
  location.replace(`${target.origin}${location.pathname}${location.search}${MIGRATE}${encodeURIComponent(payload)}`)
  return true
}
