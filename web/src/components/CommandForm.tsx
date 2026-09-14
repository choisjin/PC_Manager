import { useState } from 'react'
import { api, type Run, type ShellKind } from '../api'

interface Props {
  agentIds: string[]
  onCreated: (runs: Run[]) => void
}

const SHELLS: { value: ShellKind; label: string; placeholder: string }[] = [
  { value: 'Cmd', label: 'CMD', placeholder: '예: ipconfig /all' },
  {
    value: 'PowerShell',
    label: 'PowerShell',
    placeholder: '예: Get-Process | Sort-Object CPU -Descending | Select-Object -First 5',
  },
]

export function CommandForm({ agentIds, onCreated }: Props) {
  const [shell, setShell] = useState<ShellKind>('Cmd')
  const [commandLine, setCommandLine] = useState('')
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [timeoutSeconds, setTimeoutSeconds] = useState(600)
  const [encoding, setEncoding] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canRun = agentIds.length > 0 && commandLine.trim() !== '' && !busy

  const submit = async () => {
    if (!canRun) return
    setBusy(true)
    setError(null)
    try {
      onCreated(
        await api.createRuns({
          agentIds,
          shell,
          commandLine,
          workingDirectory: workingDirectory.trim() || null,
          timeoutSeconds,
          encoding: encoding || null,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel command">
      <div className="panel-head">
        <h2>명령 실행</h2>
        <div className="segmented" role="radiogroup" aria-label="셸">
          {SHELLS.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={shell === s.value}
              className={shell === s.value ? 'active' : ''}
              onClick={() => setShell(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="command-body">
        <textarea
          className="mono"
          rows={3}
          spellCheck={false}
          value={commandLine}
          placeholder={SHELLS.find((s) => s.value === shell)?.placeholder}
          onChange={(e) => setCommandLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void submit()
            }
          }}
        />

        <div className="form-row">
          <label>
            작업 폴더
            <input
              className="mono"
              value={workingDirectory}
              placeholder="비우면 에이전트 기본 작업 폴더"
              onChange={(e) => setWorkingDirectory(e.target.value)}
            />
          </label>
          <label className="narrow">
            제한 시간(초)
            <input
              type="number"
              min={0}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
          </label>
          <label className="narrow">
            출력 인코딩
            <select value={encoding} onChange={(e) => setEncoding(e.target.value)}>
              <option value="">시스템 기본</option>
              <option value="utf-8">UTF-8</option>
            </select>
          </label>
          <button type="button" className="primary" disabled={!canRun} onClick={() => void submit()}>
            {busy ? '요청 중…' : `선택한 ${agentIds.length}대에서 실행`}
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        <p className="hint">Ctrl+Enter로 실행 · 제한 시간 0은 무제한</p>
      </div>
    </section>
  )
}
