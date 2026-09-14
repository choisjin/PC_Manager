import { useEffect, useRef, useState } from 'react'
import { api, type InstallInfo } from '../api'

interface Props {
  onClose: () => void
}

/** 테스트 PC에 에이전트를 설치하는 한 줄 명령을 보여준다. 마운트되면 열린다. */
export function AddAgentDialog({ onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const commandRef = useRef<HTMLTextAreaElement>(null)
  const [tags, setTags] = useState('')
  const [info, setInfo] = useState<InstallInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // 태그 입력이 잠시 멈추면 태그가 들어간 명령을 다시 받는다
  useEffect(() => {
    let active = true
    const normalized = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .join(',')
    const timer = setTimeout(() => {
      api
        .installInfo(normalized)
        .then((result) => {
          if (!active) return
          setInfo(result)
          setError(null)
          setCopied(false)
        })
        .catch((err) => {
          if (active) setError(err instanceof Error ? err.message : String(err))
        })
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [tags])

  const copy = async () => {
    if (!info?.installCommand) return
    try {
      // 클립보드 API는 https나 localhost에서만 동작한다
      await navigator.clipboard.writeText(info.installCommand)
      setCopied(true)
    } catch {
      const textarea = commandRef.current
      textarea?.select()
      if (textarea && document.execCommand('copy')) setCopied(true)
      else setError('자동 복사에 실패했습니다. 명령을 직접 선택해 복사하세요.')
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="add-agent-title"
      onClose={onClose}
      onClick={(e) => {
        // 바깥(배경)을 누르면 닫는다
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
        <ol className="install-steps">
          <li>
            테스트 PC에서 <b>관리자 권한 PowerShell</b>을 엽니다.
          </li>
          <li>아래 명령을 붙여넣어 실행합니다. 설치가 끝나면 왼쪽 목록에 PC가 나타납니다.</li>
        </ol>

        <label>
          태그 (선택, 쉼표로 구분)
          <input value={tags} placeholder="예: gui-test, site:seoul" onChange={(e) => setTags(e.target.value)} />
        </label>

        {error && <p className="error">{error}</p>}

        {info && !info.agentPackageAvailable && (
          <p className="warning-box">
            이 서버에는 에이전트 설치 파일이 없습니다. 개발 모드로 실행 중이라면 <code>build/package.ps1</code>로 만든 서버
            패키지를 설치해 주세요.
          </p>
        )}

        {info?.installCommand && (
          <>
            <textarea
              ref={commandRef}
              className="mono install-command"
              readOnly
              rows={4}
              value={info.installCommand}
              aria-label="설치 명령"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="dialog-actions">
              <span className="muted small">
                서버 {info.serverUrl} · 버전 {info.serverVersion}
              </span>
              <button type="button" className="primary" onClick={() => void copy()}>
                {copied ? '복사됨 ✓' : '명령 복사'}
              </button>
            </div>
          </>
        )}

        <p className="hint">
          명령에는 에이전트 토큰이 들어 있으니 외부에 공유하지 마세요. 이미 설치된 PC에서 다시 실행하면 업그레이드됩니다.
        </p>
      </div>
    </dialog>
  )
}
