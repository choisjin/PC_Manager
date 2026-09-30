import { useEffect, useRef, useState } from 'react'

interface Props {
  onConfirm: (name: string, path: string, username?: string, password?: string) => Promise<void>
  onClose: () => void
}

/** 공유 폴더(서버가 직접 접근하는 UNC/로컬 경로) 등록 모달 */
export function AddShareModal({ onConfirm, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [useCreds, setUseCreds] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  const submit = async () => {
    if (!path.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(name.trim(), path.trim(), useCreds ? username.trim() : undefined, useCreds ? password : undefined)
      dialogRef.current?.close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog split-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current.close()
      }}
    >
      <div className="dialog-head">
        <h2>공유 폴더 등록</h2>
        <button type="button" className="icon" aria-label="닫기" onClick={() => dialogRef.current?.close()}>✕</button>
      </div>
      <div className="dialog-body">
        <p className="muted small">
          서버가 직접 접근하는 네트워크 공유 또는 로컬 폴더를 등록합니다. 서버 실행 계정이 접근할 수 있어야 합니다.
        </p>
        <label>
          경로 (UNC 또는 로컬)
          <input
            className="mono"
            autoFocus
            placeholder="\\서버\공유폴더  또는  D:\공유"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </label>
        <label>
          표시 이름 (선택)
          <input
            placeholder="비우면 폴더 이름 사용"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </label>
        <label className="creds-toggle">
          <input type="checkbox" checked={useCreds} onChange={(e) => setUseCreds(e.target.checked)} />
          <span>네트워크 자격증명으로 접속 (계정이 필요한 공유 서버)</span>
        </label>
        {useCreds && (
          <div className="creds-fields">
            <label>
              사용자 이름
              <input placeholder="예: DOMAIN\\user 또는 user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </label>
            <label>
              비밀번호
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </label>
            <p className="muted small">비밀번호는 서버에 DPAPI로 암호화되어 저장됩니다.</p>
          </div>
        )}
        {error && <p className="warning-box">{error}</p>}
      </div>
      <div className="dialog-actions">
        <span className="muted small">취소하려면 바깥을 클릭하거나 ✕</span>
        <button type="button" className="primary" disabled={!path.trim() || busy} onClick={() => void submit()}>
          {busy ? '확인 중…' : '등록'}
        </button>
      </div>
    </dialog>
  )
}
