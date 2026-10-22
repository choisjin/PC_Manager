import { useState } from 'react'
import { httpsBlocked } from '../https'

/** HTTP로 열린 이유와 HTTPS로 가는 방법 (이 PC가 서버 인증서를 아직 신뢰하지 않을 때) */
export function HttpsBanner() {
  const [hidden, setHidden] = useState(false)
  if (!httpsBlocked || hidden) return null
  const { httpsUrl, installerUrl } = httpsBlocked
  const target = `${httpsUrl}${location.pathname}${location.search}`
  return (
    <div className="https-banner warning-box" role="status">
      <span>
        이 PC가 서버 HTTPS 인증서를 아직 신뢰하지 않아 HTTP로 열었습니다. 원격조작 키 전달·영상 디코딩 등 일부 기능이 제한됩니다.
        {' '}에이전트가 설치된 PC는 10분 안에 자동으로 신뢰하고, 아니면 인증서 설치 도구를 한 번 실행한 뒤 새로 고치세요.
      </span>
      {installerUrl && <a className="button small" href={installerUrl} download>인증서 설치 도구 받기</a>}
      <a className="button small" href={target}>HTTPS로 열기</a>
      <button type="button" className="icon" aria-label="닫기" onClick={() => setHidden(true)}>✕</button>
    </div>
  )
}
