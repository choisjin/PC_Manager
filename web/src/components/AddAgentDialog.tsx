import { useEffect, useRef, useState } from 'react'
import { api, type InstallInfo } from '../api'
import { copyText } from './explorer/pcGroups'

interface Props {
  onClose: () => void
}

/** 테스트 PC에 에이전트를 설치하는 방법(더블클릭 설치 파일)을 안내한다. 마운트되면 열린다. */
export function AddAgentDialog({ onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [info, setInfo] = useState<InstallInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    dialogRef.current?.showModal()
    api
      .installInfo()
      .then(setInfo)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const copyServer = async () => {
    if (!info) return
    // http 내부망에서도 되도록 폴백 포함 복사 사용
    if (await copyText(info.serverUrl)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      setError('자동 복사에 실패했습니다. 주소를 직접 선택해 복사하세요.')
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="add-agent-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current.close()
      }}
    >
      <div className="dialog-head">
        <h2 id="add-agent-title">테스트 PC 추가</h2>
        <button type="button" className="icon" aria-label="닫기" onClick={() => dialogRef.current?.close()}>
          ✕
        </button>
      </div>

      <div className="dialog-body">
        {error && <p className="error">{error}</p>}

        {info && !info.setupAvailable && (
          <p className="warning-box">
            이 서버에는 설치 파일이 없습니다. 개발 모드로 실행 중이라면 <code>build/package.ps1</code>로 만든 서버 패키지를
            설치해 주세요.
          </p>
        )}

        <ol className="install-steps">
          <li>
            <a href={info?.setupDownloadUrl} download aria-disabled={!info?.setupAvailable}>
              설치 파일 다운로드
            </a>
            <span className="muted small"> (PcManager-Agent-Setup.exe)</span>
            {info && <span className="muted small"> · 버전 {info.serverVersion}</span>}
          </li>
          <li>테스트 PC로 옮겨 더블클릭하고, 보안 경고가 뜨면 [예]를 누릅니다.</li>
          <li>
            잠시 뒤 열리는 에이전트 창에 <b>이 서버 주소</b>를 입력하고 [연결]을 누릅니다.
          </li>
          <li>연결되면 이 목록에 PC가 나타납니다.</li>
        </ol>

        <label>
          서버 주소 (런처에 입력)
          <div className="server-url-row">
            <input className="mono" readOnly value={info?.serverUrl ?? ''} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="primary" disabled={!info} onClick={() => void copyServer()}>
              {copied ? '복사됨 ✓' : '복사'}
            </button>
          </div>
        </label>

        <p className="hint">
          설치 파일은 관리자 권한을 요청합니다(서비스 등록). 이미 설치된 PC에서 다시 실행하면 업그레이드됩니다. 서버 주소는
          런처 창에서 언제든 바꿀 수 있습니다.
        </p>

        {info?.linuxInstallCommand && (
          <>
            <h3 className="install-subhead">Linux 테스트 PC (Ubuntu/Debian)</h3>
            <label>
              터미널에서 실행 (서비스 등록·필요한 프로그램 설치까지 자동)
              <div className="server-url-row">
                <input className="mono" readOnly value={info.linuxInstallCommand} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" onClick={() => void copyText(info.linuxInstallCommand!)}>
                  복사
                </button>
              </div>
            </label>
            <p className="hint">
              원격조작은 X11 데스크톱 세션이 필요합니다 (Ubuntu 로그인 화면 톱니바퀴에서 'Ubuntu on Xorg'). 서버 주소 변경:{' '}
              <code>sudo pcmanager-agent --set-server 주소</code>
            </p>
          </>
        )}

        {info?.httpsUrl && (
          <>
            <label>
              대시보드 HTTPS 주소 (원격조작 키보드 잠금·저지연 화면)
              <div className="server-url-row">
                <input className="mono" readOnly value={info.httpsUrl} onFocus={(e) => e.currentTarget.select()} />
                <a className="button" href={info.httpsUrl}>열기</a>
              </div>
            </label>
            <p className="hint">
              서버 PC와 에이전트가 설치된 PC는 인증서가 자동으로 신뢰됩니다. 그 밖의 PC에서 경고 없이 열려면{' '}
              {info.certificateInstallerUrl ? (
                <a href={info.certificateInstallerUrl} download>
                  인증서 설치 도구
                </a>
              ) : (
                '인증서 설치 도구'
              )}
              를 받아 더블클릭하세요 (관리자 승인 한 번).
            </p>
          </>
        )}
      </div>
    </dialog>
  )
}
