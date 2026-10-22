import { useEffect, useState } from 'react'
import { api, type InstallInfo } from '../api'
import { copyText } from './explorer/pcGroups'

/**
 * 대시보드를 연 PC에 에이전트가 없으면 로그인 전에 설치부터 안내한다.
 * 설치한 에이전트가 이 서버에 연결되면 PC 목록이 바뀌며 자동으로 다음 화면(로그인)으로 넘어간다.
 * 설치할 수 없는 PC는 안 되는 기능을 확인하고 에이전트 없이 계속할 수 있다 (이 브라우저는 기억)
 */
export function AgentInstallGate({ clientIp, platform, onSkip }: {
  clientIp: string
  platform: 'windows' | 'linux'
  onSkip: () => void
}) {
  const [skipping, setSkipping] = useState(false)
  const [info, setInfo] = useState<InstallInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    api.installInfo().then(setInfo, (err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const copy = async (text: string) => {
    if (await copyText(text)) {
      setCopied(text)
      setTimeout(() => setCopied(null), 2000)
    } else {
      setError('자동 복사에 실패했습니다. 직접 선택해 복사하세요.')
    }
  }

  return (
    <div className="gate">
      <div className="gate-card agent-gate">
        <h1 className="gate-title">이 PC에 에이전트를 먼저 설치하세요</h1>
        <p className="gate-sub muted">
          {`이 PC(${clientIp})에 PC Manager 에이전트가 없습니다. 에이전트가 있어야 이 PC에서 HTTPS 접속·파일 열기·원격조작 키 전달이 됩니다. 설치해 이 서버에 연결되면 자동으로 로그인 화면으로 넘어갑니다.`}
        </p>
        {error && <p className="error">{error}</p>}

        {platform === 'windows' ? (
          <>
            {info && !info.setupAvailable && <p className="warning-box">이 서버에는 설치 파일이 없습니다. 관리자에게 문의하세요.</p>}
            <ol className="install-steps">
              <li>
                <a href={info?.setupDownloadUrl} download aria-disabled={!info?.setupAvailable}>설치 파일 다운로드</a>
                <span className="muted small"> (PcManager-Agent-Setup.exe)</span>
              </li>
              <li>받은 파일을 실행하고, 보안 경고가 뜨면 [예]를 누릅니다.</li>
              <li>열리는 에이전트 창에 아래 서버 주소를 입력하고 [연결]을 누릅니다.</li>
            </ol>
            <label>
              서버 주소
              <div className="server-url-row">
                <input className="mono" readOnly value={info?.serverUrl ?? ''} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="primary" disabled={!info} onClick={() => info && void copy(info.serverUrl)}>
                  {copied && copied === info?.serverUrl ? '복사됨 ✓' : '복사'}
                </button>
              </div>
            </label>
          </>
        ) : info?.linuxInstallCommand ? (
          <label>
            터미널에서 실행 (서비스 등록·필요한 프로그램 설치까지 자동)
            <div className="server-url-row">
              <input className="mono" readOnly value={info.linuxInstallCommand} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="primary" onClick={() => void copy(info.linuxInstallCommand!)}>
                {copied === info.linuxInstallCommand ? '복사됨 ✓' : '복사'}
              </button>
            </div>
          </label>
        ) : (
          info && <p className="warning-box">이 서버에는 Linux 에이전트가 없습니다. 관리자에게 문의하세요.</p>
        )}

        <p className="hint">이미 설치했다면 에이전트 창에서 이 서버 주소로 연결돼 있는지 확인하세요. 연결을 기다리는 중…</p>

        {!skipping ? (
          <button type="button" className="small agent-gate-skip-open" onClick={() => setSkipping(true)}>에이전트 없이 계속…</button>
        ) : (
          <div className="warning-box agent-gate-skip">
            <b>에이전트 없이 쓰면 이 PC에서 안 되는 기능</b>
            <ul>
              <li>HTTPS 자동 접속: 서버 인증서를 자동으로 신뢰하지 못해 HTTP로 열립니다 (인증서 설치 도구를 따로 실행하면 HTTPS 가능)</li>
              <li>원격조작에서 Alt+Tab·Win 키 직접 전달과 저지연 영상 디코딩 (HTTP일 때)</li>
              <li>파일을 내 PC 프로그램으로 열기·고친 뒤 원래 위치에 저장 (탐색기 더블클릭·파일 즐겨찾기)</li>
              <li>원격조작 중 복사한 파일을 이 PC에 붙여넣기</li>
              <li>편집 폴더 관리, 다른 사람이 이 PC를 목록에서 보고 원격조작·파일 탐색</li>
            </ul>
            <span className="agent-gate-actions">
              <button type="button" className="small" onClick={() => setSkipping(false)}>취소</button>
              <button type="button" className="small primary" onClick={onSkip}>알겠습니다, 에이전트 없이 계속</button>
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
