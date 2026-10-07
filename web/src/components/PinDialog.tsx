import { useEffect, useRef, useState } from 'react'
import { PIN_PATTERN, type PinRequest, registerPinAsker } from '../pinPrompt'

interface Pending extends PinRequest {
  resolve: (pin: string | null) => void
}

/** PIN 입력 창 (앱에 하나). askPin()이 부르면 열린다 */
export function PinDialog() {
  const [request, setRequest] = useState<Pending | null>(null)
  const [pin, setPin] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    registerPinAsker(
      (next) =>
        new Promise<string | null>((resolve) => {
          setPin('')
          setAgain('')
          setError(next.error ?? null)
          setRequest((prev) => {
            // 이미 열려 있던 요청은 취소로 끝낸다
            prev?.resolve(null)
            return { ...next, resolve }
          })
        }),
    )
    return () => registerPinAsker(null)
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (request && dialog && !dialog.open) dialog.showModal()
  }, [request])

  const finish = (value: string | null) => {
    request?.resolve(value)
    setRequest(null)
    dialogRef.current?.close()
  }

  const submit = () => {
    if (!PIN_PATTERN.test(pin)) {
      setError('PIN은 숫자 4~12자리입니다.')
      return
    }
    if (request?.confirm && pin !== again) {
      setError('두 번 입력한 PIN이 다릅니다.')
      return
    }
    finish(pin)
  }

  if (!request) return null
  return (
    <dialog
      ref={dialogRef}
      className="dialog pin-dialog"
      // PiP가 이 창 안으로 들어와 가리지 않게
      data-no-pip
      aria-labelledby="pin-title"
      // Esc = 취소
      onCancel={(e) => {
        e.preventDefault()
        finish(null)
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="dialog-head">
          <h2 id="pin-title">🔒 {request.title}</h2>
          <button type="button" className="icon" aria-label="닫기" onClick={() => finish(null)}>
            ✕
          </button>
        </div>
        <div className="dialog-body">
          {request.message && <p className="small muted pin-message">{request.message}</p>}
          <label>
            {request.confirm ? '새 PIN (숫자 4~12자리)' : 'PIN'}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={12}
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          {request.confirm && (
            <label>
              새 PIN 확인
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={12}
                value={again}
                onChange={(e) => setAgain(e.target.value.replace(/\D/g, ''))}
              />
            </label>
          )}
          {error && <p className="error small">{error}</p>}
          <div className="pin-actions">
            <button type="button" onClick={() => finish(null)}>
              취소
            </button>
            <button type="submit" className="primary">
              확인
            </button>
          </div>
        </div>
      </form>
    </dialog>
  )
}
