import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, isActiveRun, type Agent, type OutputLine, type Run } from '../api'
import type { WatchRun } from '../useDashboard'
import { StateBadge } from './StateBadge'

const MAX_LINES = 5000

interface Props {
  run: Run
  agent: Agent | undefined
  watchRun: WatchRun
}

export function RunOutput({ run, agent, watchRun }: Props) {
  const [lines, setLines] = useState<OutputLine[]>([])
  const [cancelling, setCancelling] = useState(false)
  const terminalRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    let subscribed = true
    const seen = new Set<number>()

    const append = (incoming: OutputLine[]) => {
      if (!subscribed) return
      const fresh = incoming.filter((line) => !seen.has(line.seq))
      if (fresh.length === 0) return
      for (const line of fresh) seen.add(line.seq)

      setLines((prev) => {
        const merged = prev.concat(fresh)
        // 실시간 줄이 기존 로그보다 먼저 도착한 경우에만 정렬
        if (prev.length > 0 && fresh[0].seq < prev[prev.length - 1].seq) {
          merged.sort((a, b) => a.seq - b.seq)
        }
        return merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged
      })
    }

    const unwatch = watchRun(run.id, {
      onLines: append,
      onResync: () => {
        api.output(run.id).then(append).catch(console.error)
      },
    })

    return () => {
      subscribed = false
      unwatch()
    }
  }, [run.id, watchRun])

  useLayoutEffect(() => {
    const el = terminalRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [lines])

  const handleScroll = () => {
    const el = terminalRef.current
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const cancel = async () => {
    setCancelling(true)
    try {
      await api.cancelRun(run.id)
    } catch (err) {
      console.error(err)
    } finally {
      setCancelling(false)
    }
  }

  const active = isActiveRun(run.state)
  const omitted = lines.length > 0 ? lines[0].seq - 1 : 0

  return (
    <section className="panel output">
      <div className="panel-head">
        <div className="output-title">
          <StateBadge state={run.state} />
          <strong className="ellipsis">{agent?.machineName ?? run.agentId.slice(0, 8)}</strong>
          <code className="mono ellipsis" title={run.commandLine}>
            {run.commandLine}
          </code>
        </div>
        <div className="output-actions">
          {run.exitCode !== null && (
            <span className="muted">
              종료 코드 <b className="mono">{run.exitCode}</b>
            </span>
          )}
          {active && (
            <button type="button" className="danger" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? '취소 요청 중…' : '실행 취소'}
            </button>
          )}
        </div>
      </div>

      {run.error && <div className="output-error">{run.error}</div>}

      <div className="terminal mono" ref={terminalRef} onScroll={handleScroll}>
        {omitted > 0 && (
          <div className="line System">
            … 앞부분 {omitted.toLocaleString()}줄 생략 (최근 {MAX_LINES.toLocaleString()}줄만 표시)
          </div>
        )}
        {lines.map((line) => (
          <div key={line.seq} className={`line ${line.stream}`}>
            {line.text || ' '}
          </div>
        ))}
        {lines.length === 0 && (
          <div className="line System">{active ? '출력 대기 중…' : '출력이 없습니다.'}</div>
        )}
      </div>
    </section>
  )
}
