import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, isActiveRun, type OutputLine, type ShellKind } from '../../api'
import type { WatchRun } from '../../useDashboard'

interface Props {
  agentId: string
  machineName: string
  path: string
  watchRun: WatchRun
  onClose: () => void
}

interface Entry {
  key: number
  shell: ShellKind
  command: string
  lines: OutputLine[]
  exitCode?: number | null
  state?: string
}

const MAX_LINES = 4000

/** 특정 PC·경로에서 바로 명령을 보내는 명령 프롬프트 스타일 모달 */
export function TerminalModal({ agentId, machineName, path, watchRun, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [shell, setShell] = useState<ShellKind>('Cmd')
  const [entries, setEntries] = useState<Entry[]>([])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIndex, setHistIndex] = useState(-1)
  const [running, setRunning] = useState(false)
  const keyRef = useRef(0)

  useEffect(() => {
    dialogRef.current?.showModal()
    inputRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  const run = async () => {
    const command = input.trim()
    if (!command || running) return
    setInput('')
    setHistory((h) => [...h, command])
    setHistIndex(-1)
    const key = ++keyRef.current
    setEntries((prev) => [...prev, { key, shell, command, lines: [] }].slice(-200))
    setRunning(true)

    let unwatch = () => {}
    try {
      const runs = await api.createRuns({
        agentIds: [agentId],
        shell,
        commandLine: command,
        workingDirectory: path || null,
        timeoutSeconds: 0,
        encoding: null,
      })
      const runId = runs[0]?.id
      if (!runId) throw new Error('실행을 시작하지 못했습니다.')

      const seen = new Set<number>()
      const appendLines = (incoming: OutputLine[]) => {
        const fresh = incoming.filter((l) => !seen.has(l.seq))
        if (fresh.length === 0) return
        for (const l of fresh) seen.add(l.seq)
        setEntries((prev) =>
          prev.map((e) => (e.key === key ? { ...e, lines: [...e.lines, ...fresh].slice(-MAX_LINES) } : e)),
        )
      }

      unwatch = watchRun(runId, {
        onLines: appendLines,
        onResync: () => {
          api.output(runId).then(appendLines).catch(console.error)
        },
      })

      // 완료까지 상태 폴링
      for (;;) {
        await new Promise((r) => setTimeout(r, 600))
        const info = await api.run(runId)
        if (!isActiveRun(info.state)) {
          setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, exitCode: info.exitCode, state: info.state } : e)))
          break
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setEntries((prev) =>
        prev.map((e) => (e.key === key ? { ...e, state: 'Failed', exitCode: null, lines: [...e.lines, sysLine(message)] } : e)),
      )
    } finally {
      unwatch()
      setRunning(false)
      inputRef.current?.focus()
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void run()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = histIndex < 0 ? history.length - 1 : Math.max(0, histIndex - 1)
      if (history[idx] !== undefined) {
        setHistIndex(idx)
        setInput(history[idx])
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIndex < 0) return
      const idx = histIndex + 1
      if (idx >= history.length) {
        setHistIndex(-1)
        setInput('')
      } else {
        setHistIndex(idx)
        setInput(history[idx])
      }
    }
  }

  // 입력줄 프롬프트는 짧게 (전체 경로는 헤더와 각 명령 앞에 표시)
  const prompt = shell === 'PowerShell' ? 'PS>' : '>'

  return (
    <dialog
      ref={dialogRef}
      className="dialog terminal-dialog"
      aria-label={`${machineName} 터미널`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current.close()
      }}
    >
      <div className="dialog-head terminal-head">
        <span className="ellipsis">
          <b>{machineName}</b> <span className="mono muted small">{path || '(경로 없음)'}</span>
        </span>
        <span className="terminal-head-actions">
          <span className="segmented" role="radiogroup" aria-label="셸">
            {(['Cmd', 'PowerShell'] as ShellKind[]).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={shell === s} className={shell === s ? 'active' : ''} onClick={() => setShell(s)}>
                {s === 'Cmd' ? 'CMD' : 'PowerShell'}
              </button>
            ))}
          </span>
          <button type="button" className="icon" title="지우기" disabled={running} onClick={() => setEntries([])}>
            🗑
          </button>
          <button type="button" className="icon" aria-label="닫기" onClick={() => dialogRef.current?.close()}>
            ✕
          </button>
        </span>
      </div>

      <div className="terminal-body mono" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        {entries.length === 0 && <div className="term-hint">이 경로에서 실행할 명령을 입력하세요. ↑↓로 기록 탐색.</div>}
        {entries.map((entry) => (
          <div key={entry.key} className="term-entry">
            <div className="term-command">
              <span className="term-prompt-text">{entry.shell === 'PowerShell' ? `PS ${path}>` : `${path}>`}</span> {entry.command}
            </div>
            {entry.lines.map((line) => (
              <div key={line.seq} className={`line ${line.stream}`}>
                {line.text || ' '}
              </div>
            ))}
            {entry.state && entry.state !== 'Succeeded' && (
              <div className="line System">[{entry.state}{entry.exitCode != null ? ` · 종료 코드 ${entry.exitCode}` : ''}]</div>
            )}
          </div>
        ))}
      </div>

      <div className="terminal-input">
        <span className="term-prompt-text">{prompt}</span>
        <input
          ref={inputRef}
          className="mono"
          value={input}
          disabled={running}
          placeholder={running ? '실행 중…' : '명령 입력 후 Enter'}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </dialog>
  )
}

function sysLine(text: string): OutputLine {
  return { runId: '', seq: -Date.now(), stream: 'System', text, timestamp: new Date().toISOString() }
}
