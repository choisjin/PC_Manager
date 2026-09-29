import { useEffect, useRef, useState } from 'react'

interface Props {
  /** 압축할 항목 수 (안내 문구용) */
  count: number
  onConfirm: (splitBytes: number) => void
  onClose: () => void
}

const MB = 1024 * 1024
const GB = 1024 * MB

interface Preset {
  label: string
  value: number
  unit: 'MB' | 'GB'
}

const PRESETS: Preset[] = [
  { label: '100 MB', value: 100, unit: 'MB' },
  { label: '700 MB (CD)', value: 700, unit: 'MB' },
  { label: '1 GB', value: 1, unit: 'GB' },
  { label: '2 GB', value: 2, unit: 'GB' },
  { label: '4 GB (DVD)', value: 4, unit: 'GB' },
]

/** 분할 압축 볼륨 크기를 고르는 모달 */
export function SplitCompressModal({ count, onConfirm, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [value, setValue] = useState('100')
  const [unit, setUnit] = useState<'MB' | 'GB'>('MB')

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  const bytes = Math.round(parseFloat(value) * (unit === 'GB' ? GB : MB))
  const valid = Number.isFinite(bytes) && bytes >= 64 * 1024

  const confirm = () => {
    if (!valid) return
    onConfirm(bytes)
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
        <h2>분할 압축</h2>
        <button type="button" className="icon" aria-label="닫기" onClick={() => dialogRef.current?.close()}>
          ✕
        </button>
      </div>
      <div className="dialog-body">
        <p className="muted small">
          선택한 {count}개 항목을 하나의 ZIP으로 압축한 뒤 아래 크기로 나눕니다. 볼륨은{' '}
          <span className="mono">이름.zip.001</span>, <span className="mono">.002</span> … 로 만들어집니다.
        </p>
        <div className="split-presets">
          {PRESETS.map((p) => {
            const active = value === String(p.value) && unit === p.unit
            return (
              <button
                key={p.label}
                type="button"
                className={`split-preset${active ? ' active' : ''}`}
                onClick={() => {
                  setValue(String(p.value))
                  setUnit(p.unit)
                }}
              >
                {p.label}
              </button>
            )
          })}
        </div>
        <label>
          볼륨 크기 직접 입력
          <span className="split-size-row">
            <input
              type="number"
              min="0"
              step="any"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm()
              }}
            />
            <select value={unit} onChange={(e) => setUnit(e.target.value as 'MB' | 'GB')}>
              <option value="MB">MB</option>
              <option value="GB">GB</option>
            </select>
          </span>
        </label>
        {!valid && <p className="warning-box">볼륨 크기는 64KB 이상이어야 합니다.</p>}
      </div>
      <div className="dialog-actions">
        <span className="muted small">취소하려면 바깥을 클릭하거나 ✕</span>
        <button type="button" className="primary" disabled={!valid} onClick={confirm}>
          분할 압축 시작
        </button>
      </div>
    </dialog>
  )
}
