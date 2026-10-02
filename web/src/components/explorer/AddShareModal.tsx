import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'

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

  // 경로를 입력하면 서버가 자격증명 없이 열리는지 확인한다 → 필요한 폴더만 사용자 이름·비밀번호 필수
  type Probe = { state: 'idle' | 'checking' | 'open' | 'needs' | 'error'; message?: string }
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })
  useEffect(() => {
    const target = path.trim()
    if (!target) {
      setProbe({ state: 'idle' })
      return
    }
    setProbe({ state: 'checking' })
    let cancelled = false
    const timer = setTimeout(() => {
      api.probeShare(target).then(
        (r) => {
          if (cancelled) return
          setProbe(r.accessible ? { state: 'open' } : r.needsCredentials ? { state: 'needs', message: r.error ?? undefined } : { state: 'error', message: r.error ?? '접근할 수 없습니다.' })
        },
        (err) => !cancelled && setProbe({ state: 'error', message: err instanceof Error ? err.message : String(err) }),
      )
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [path])

  const needsCreds = probe.state === 'needs'
  const hasCreds = username.trim() !== '' && password !== ''
  // 확인 중이거나 경로 오류면 등록 불가. 권한이 필요한 폴더는 사용자 이름·비밀번호 필수
  const ready = path.trim() !== '' && (probe.state === 'open' || (needsCreds && hasCreds))

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
          다른 사용자에게는 보이지 않습니다. 경로를 입력하면 권한이 필요한 폴더인지 확인해 알려 줍니다.
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
        {probe.state !== 'idle' && (
          <p className={`share-probe small ${probe.state}`}>
            {probe.state === 'checking' && '접근 확인 중…'}
            {probe.state === 'open' && '✓ 자격증명 없이 접근할 수 있습니다. 사용자 이름은 비워도 됩니다.'}
            {probe.state === 'needs' && '🔒 이 폴더는 권한이 필요합니다. 사용자 이름과 비밀번호를 입력하세요.'}
            {probe.state === 'error' && `✕ ${probe.message}`}
          </p>
        )}
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
            사용자 이름{needsCreds ? ' (필수)' : ' (선택)'}
            <input
              placeholder="예: DOMAIN\user, user@domain 또는 NAS 계정 user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            비밀번호{needsCreds ? ' (필수)' : ' (선택)'}
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
