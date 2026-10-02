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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // 네트워크 공유(\\서버\공유)는 자격증명 필수. 서버 로컬 폴더는 자격증명 없이도 된다
  const isNetwork = path.trim().startsWith('\\\\')
  const ready = path.trim() !== '' && (!isNetwork || (username.trim() !== '' && password !== ''))

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(name.trim(), path.trim(), username.trim() || undefined, username.trim() ? password : undefined)
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
          서버가 직접 접근하는 네트워크 공유 또는 서버의 로컬 폴더를 등록합니다. 목록과 자격증명은 <b>내 계정에만</b> 저장되며
          다른 사용자에게는 보이지 않습니다. 네트워크 공유는 자격증명이 필요합니다.
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
        <div className="creds-fields">
          <label>
            사용자 이름{isNetwork ? ' (필수)' : ' (서버 로컬 폴더는 선택)'}
            <input
              placeholder="예: DOMAIN\user, user@domain 또는 NAS 계정 user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            비밀번호{isNetwork ? ' (필수)' : ''}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
            />
          </label>
          <p className="muted small">비밀번호는 서버에 암호화(DPAPI)되어 저장되고, 이 공유 폴더에 접근할 때만 쓰입니다.</p>
        </div>
        {error && <p className="warning-box">{error}</p>}
      </div>
      <div className="dialog-actions">
        <span className="muted small">취소하려면 바깥을 클릭하거나 ✕</span>
        <button type="button" className="primary" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? '확인 중…' : '등록'}
        </button>
      </div>
    </dialog>
  )
}
