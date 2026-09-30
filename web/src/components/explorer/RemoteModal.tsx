import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { MseSink, type VideoSink, WebCodecsSink, webCodecsAvailable } from '../remote/sinks'
import { ContextMenu, type MenuItem } from './ContextMenu'

interface Props {
  agentId: string
  machineName: string
  onClose: () => void
}

interface Monitor {
  index: number
  name: string
  primary: boolean
  width: number
  height: number
}

interface Format {
  width: number
  height: number
  capture: string
}

type Phase = 'connecting' | 'live' | 'closed'

const QUALITIES = [
  { label: '낮음', bitrate: 2_000_000 },
  { label: '보통', bitrate: 6_000_000 },
  { label: '높음', bitrate: 12_000_000 },
]

// 브라우저/OS가 가로채서 직접 누를 수 없는 조합
const COMBOS: { label: string; codes: string[] }[] = [
  { label: 'Windows 키', codes: ['MetaLeft'] },
  { label: 'Alt + Tab', codes: ['AltLeft', 'Tab'] },
  { label: 'Win + D (바탕 화면)', codes: ['MetaLeft', 'KeyD'] },
  { label: 'Win + R (실행)', codes: ['MetaLeft', 'KeyR'] },
  { label: 'Ctrl + Shift + Esc (작업 관리자)', codes: ['ControlLeft', 'ShiftLeft', 'Escape'] },
  { label: 'Alt + F4', codes: ['AltLeft', 'F4'] },
  { label: 'Print Screen', codes: ['PrintScreen'] },
]

/** 원격 PC 화면 보기 + 마우스/키보드 조작 (H.264 스트리밍) */
export function RemoteModal({ agentId, machineName, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const formatRef = useRef<Format | null>(null)
  const viewOnlyRef = useRef(false)
  const pressedRef = useRef(new Set<string>())
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null)
  const moveFrameRef = useRef(0)

  const [useWebCodecs] = useState(webCodecsAvailable)
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<Phase>('connecting')
  const [message, setMessage] = useState<string | null>('연결 중…')
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [monitor, setMonitor] = useState(-1)
  const [format, setFormat] = useState<Format | null>(null)
  const [desktop, setDesktop] = useState<string | null>(null)
  const [stats, setStats] = useState({ fps: 0, kbps: 0 })
  const [quality, setQuality] = useState(1)
  const [viewOnly, setViewOnly] = useState(false)
  const [cursor, setCursor] = useState<{ x: number; y: number; visible: boolean } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [textOpen, setTextOpen] = useState(false)
  const [text, setText] = useState('')

  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    dialogRef.current?.showModal()
    const stage = stageRef.current
    if (!stage) return
    stage.focus()
    // 보기 전용 커서 위치 계산용
    const observer = new ResizeObserver(() => setStageSize({ width: stage.clientWidth, height: stage.clientHeight }))
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const changeViewOnly = (value: boolean) => {
    viewOnlyRef.current = value
    setViewOnly(value)
  }

  // 연결 (다시 연결하면 attempt가 바뀐다)
  useEffect(() => {
    const surface = useWebCodecs ? canvasRef.current : videoRef.current
    if (!surface) return
    const sink: VideoSink = useWebCodecs
      ? new WebCodecsSink(surface as HTMLCanvasElement)
      : new MseSink(surface as HTMLVideoElement)

    setPhase('connecting')
    setMessage('연결 중…')
    const ws = new WebSocket(api.remoteUrl(agentId))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    let frames = 0
    let bytes = 0
    let lastKeyRequest = 0
    const requestKey = () => {
      const now = performance.now()
      if (now - lastKeyRequest < 1000 || ws.readyState !== WebSocket.OPEN) return
      lastKeyRequest = now
      ws.send(JSON.stringify({ t: 'keyframe' }))
    }
    const statsTimer = setInterval(() => {
      setStats({ fps: frames, kbps: Math.round((bytes * 8) / 1000) })
      frames = 0
      bytes = 0
    }, 1000)

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data)
        switch (msg.type) {
          case 'hello': {
            setMonitors(msg.monitors)
            const primary = (msg.monitors as Monitor[]).find((m) => m.primary)
            setMonitor(primary?.index ?? 0)
            setDesktop(msg.desktop ?? null)
            break
          }
          case 'format':
            formatRef.current = msg
            setFormat(msg)
            sink.reset(msg.width, msg.height)
            break
          case 'status':
            setDesktop(msg.desktop ?? null)
            break
          case 'cursor':
            setCursor({ x: msg.x, y: msg.y, visible: msg.visible })
            break
          case 'error':
            setMessage(msg.message)
            break
        }
        return
      }

      const buf = e.data as ArrayBuffer
      const view = new DataView(buf)
      if (view.getUint8(0) !== 1) return
      const isKey = (view.getUint8(1) & 1) === 1
      const timestamp = Number(view.getBigInt64(2, true))
      frames++
      bytes += buf.byteLength
      if (!sink.push({ data: new Uint8Array(buf, 10), isKey, timestamp })) {
        requestKey()
        return
      }
      setPhase((p) => {
        if (p !== 'live') setMessage(null)
        return 'live'
      })
    }
    ws.onclose = (e) => {
      setPhase('closed')
      setMessage(e.reason || '연결이 끊어졌습니다.')
    }

    return () => {
      clearInterval(statsTimer)
      ws.onmessage = null
      ws.onclose = null
      ws.close()
      sink.close()
      wsRef.current = null
      setFormat(null)
      formatRef.current = null
    }
  }, [agentId, attempt, useWebCodecs])

  const send = (msg: object) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const sendInput = (msg: object) => {
    if (!viewOnlyRef.current) send(msg)
  }

  // 화면 요소 안의 실제 영상 영역(object-fit: contain) 기준 0~1 좌표
  const toRemote = (clientX: number, clientY: number) => {
    const f = formatRef.current
    const el = (useWebCodecs ? canvasRef.current : videoRef.current) as HTMLElement | null
    if (!f || !el) return null
    const rect = el.getBoundingClientRect()
    const scale = Math.min(rect.width / f.width, rect.height / f.height)
    const w = f.width * scale
    const h = f.height * scale
    const left = rect.left + (rect.width - w) / 2
    const top = rect.top + (rect.height - h) / 2
    return {
      x: Math.min(1, Math.max(0, (clientX - left) / w)),
      y: Math.min(1, Math.max(0, (clientY - top) / h)),
    }
  }

  const flushMove = () => {
    cancelAnimationFrame(moveFrameRef.current)
    moveFrameRef.current = 0
    const p = pendingMoveRef.current
    pendingMoveRef.current = null
    if (p) sendInput({ t: 'm', x: p.x, y: p.y })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toRemote(e.clientX, e.clientY)
    if (!p) return
    // 화면 갱신 주기에 맞춰 한 번씩만 보낸다
    pendingMoveRef.current = p
    if (!moveFrameRef.current) moveFrameRef.current = requestAnimationFrame(flushMove)
  }

  const onPointerButton = (e: React.PointerEvent, down: boolean) => {
    const p = toRemote(e.clientX, e.clientY)
    if (!p) return
    if (down) {
      stageRef.current?.focus()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }
    e.preventDefault()
    flushMove()
    sendInput({ t: down ? 'md' : 'mu', b: e.button, x: p.x, y: p.y })
  }

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 120 : 1.2
    const dy = -Math.round(e.deltaY * factor)
    const dx = Math.round(e.deltaX * factor)
    if (dx || dy) sendInput({ t: 'w', dx, dy })
  }

  const onKey = (e: React.KeyboardEvent, down: boolean) => {
    if (viewOnlyRef.current || !e.code) return
    e.preventDefault()
    e.stopPropagation()
    if (down) pressedRef.current.add(e.code)
    else pressedRef.current.delete(e.code)
    // 수식 키 상태를 함께 보내, 원격에서 Shift+숫자 등이 어긋나지 않게 한다
    send({ t: down ? 'kd' : 'ku', code: e.code, key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey })
  }

  // 포커스를 잃으면 눌린 채 남은 키를 뗀다 (Alt+Tab 등). reset으로 원격의 수식 키도 모두 해제
  const releaseKeys = () => {
    for (const code of pressedRef.current) send({ t: 'ku', code })
    pressedRef.current.clear()
    send({ t: 'reset' })
  }

  const changeMonitor = (index: number) => {
    setMonitor(index)
    send({ t: 'monitor', index })
  }

  const changeQuality = (index: number) => {
    setQuality(index)
    send({ t: 'quality', bitrate: QUALITIES[index].bitrate })
  }

  const toggleFullscreen = async () => {
    // 모달 <dialog>는 이미 최상위 레이어라 전체 화면 요청이 무시된다 → 화면 영역(stage)을 전체 화면으로
    const stage = stageRef.current
    if (!stage) return
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await stage.requestFullscreen()
        // 전체 화면에서는 Win, Alt+Tab 같은 키도 가로챌 수 있다 (HTTPS에서만 지원)
        const keyboard = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard
        await keyboard?.lock?.().catch(() => {})
      }
    } catch (err) {
      setMessage(`전체 화면을 전환하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
    }
    stage.focus()
  }

  const specialMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({
      x: r.left,
      y: r.bottom + 2,
      items: [
        {
          label: 'Ctrl + Alt + Del',
          onClick: () => {
            api.sendCtrlAltDel(agentId).catch((err: unknown) => setMessage(err instanceof Error ? err.message : String(err)))
          },
        },
        { separator: true },
        ...COMBOS.map((c) => ({ label: c.label, onClick: () => sendInput({ t: 'combo', codes: c.codes }) })),
        { separator: true },
        { label: '텍스트 보내기…', onClick: () => setTextOpen(true) },
      ],
    })
  }

  const sendText = () => {
    if (text) sendInput({ t: 'text', text })
    setText('')
    setTextOpen(false)
    stageRef.current?.focus()
  }

  const secureDesktop = desktop != null && desktop.toLowerCase() !== 'default'
  const statusText =
    phase === 'live' && format
      ? `${format.width}×${format.height} · ${stats.fps}fps · ${(stats.kbps / 1000).toFixed(1)}Mbps · ${useWebCodecs ? 'WebCodecs' : 'MSE'} · ${format.capture.toUpperCase()}`
      : phase === 'connecting'
        ? '연결 중…'
        : '연결 끊김'

  return (
    <dialog
      ref={dialogRef}
      className="dialog remote-dialog"
      aria-label={`${machineName} 원격조작`}
      onClose={onClose}
      // Esc는 원격 PC로 보낸다 (닫기는 ✕ 버튼)
      onCancel={(e) => e.preventDefault()}
    >
      <div className="dialog-head remote-head">
        <span className="remote-title ellipsis">
          <span className={`remote-dot ${phase}`} />
          <b>{machineName}</b>
          <span className="muted small">{statusText}</span>
          {secureDesktop && <span className="remote-badge">보안 데스크톱</span>}
        </span>
        <span className="remote-actions">
          {monitors.length > 1 && (
            <select aria-label="모니터" value={monitor} onChange={(e) => changeMonitor(Number(e.target.value))}>
              {monitors.map((m) => (
                <option key={m.index} value={m.index}>
                  모니터 {m.index + 1}{m.primary ? ' (주)' : ''} · {m.width}×{m.height}
                </option>
              ))}
            </select>
          )}
          <span className="segmented" role="radiogroup" aria-label="화질">
            {QUALITIES.map((q, i) => (
              <button key={q.label} type="button" role="radio" aria-checked={quality === i} className={quality === i ? 'active' : ''} onClick={() => changeQuality(i)}>
                {q.label}
              </button>
            ))}
          </span>
          <label className="remote-toggle">
            <input type="checkbox" checked={viewOnly} onChange={(e) => changeViewOnly(e.target.checked)} /> 보기 전용
          </label>
          <button type="button" disabled={viewOnly || phase !== 'live'} onClick={specialMenu}>
            특수 키 ▾
          </button>
          <button type="button" className="icon" title="전체 화면" onClick={() => void toggleFullscreen()}>
            ⛶
          </button>
          <button type="button" className="icon" aria-label="닫기" onClick={() => dialogRef.current?.close()}>
            ✕
          </button>
        </span>
      </div>

      <div
        ref={stageRef}
        className={`remote-stage${viewOnly ? ' view-only' : ''}`}
        tabIndex={0}
        onPointerMove={onPointerMove}
        onPointerDown={(e) => onPointerButton(e, true)}
        onPointerUp={(e) => onPointerButton(e, false)}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => onKey(e, true)}
        onKeyUp={(e) => onKey(e, false)}
        onBlur={releaseKeys}
      >
        {useWebCodecs ? <canvas ref={canvasRef} className="remote-surface" /> : <video ref={videoRef} className="remote-surface" muted playsInline />}

        {viewOnly && cursor?.visible && format && <RemoteCursor x={cursor.x} y={cursor.y} stage={stageSize} format={format} />}

        {message && (
          <div className="remote-overlay">
            <p>{message}</p>
            {phase === 'closed' && (
              <button type="button" className="primary" onClick={() => setAttempt((n) => n + 1)}>
                다시 연결
              </button>
            )}
          </div>
        )}

        {textOpen && (
          <form
            className="remote-text"
            onSubmit={(e) => {
              e.preventDefault()
              sendText()
            }}
            onKeyDown={(e) => e.stopPropagation()}
            onKeyUp={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <textarea autoFocus rows={3} placeholder="원격 PC에 입력할 텍스트 (Ctrl+Enter로 보내기)" value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.ctrlKey) {
                  e.preventDefault()
                  sendText()
                } else if (e.key === 'Escape') {
                  setTextOpen(false)
                }
              }}
            />
            <div className="remote-text-actions">
              <button type="button" onClick={() => setTextOpen(false)}>취소</button>
              <button type="submit" className="primary">보내기</button>
            </div>
          </form>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </dialog>
  )
}

/** 보기 전용일 때 원격 PC의 마우스 위치 표시 */
function RemoteCursor({ x, y, stage: rect, format }: { x: number; y: number; stage: { width: number; height: number }; format: Format }) {
  const scale = Math.min(rect.width / format.width, rect.height / format.height)
  const w = format.width * scale
  const h = format.height * scale
  const left = (rect.width - w) / 2 + x * w
  const top = (rect.height - h) / 2 + y * h
  return (
    <svg className="remote-cursor" style={{ left, top }} width="16" height="22" viewBox="0 0 16 22" aria-hidden>
      <path d="M1 1v17l4.5-4.2 3 6.7 2.6-1.2-3-6.5H14z" fill="#fff" stroke="#000" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}
