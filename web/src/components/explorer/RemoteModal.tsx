import { useContext, useEffect, useRef, useState } from 'react'
import { api, PC_STATUS_LABEL } from '../../api'
import { RemoteContext } from '../remote/RemoteContext'
import { MseSink, type VideoSink, WebCodecsSink, webCodecsAvailable } from '../remote/sinks'
import { Icon, type IconName } from './Icon'

interface Props {
  agentId: string
  machineName: string
  userId: string | null
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

// 브라우저/OS가 가로채서 로컬에서 직접 누를 수 없는 키. 아이콘 버튼으로 원격에 보낸다
// (전체 화면 + 키보드 잠금이면 Ctrl+Alt+Del을 뺀 나머지는 직접 눌러도 전달된다)
interface SpecialKey {
  icon: IconName
  label: string
  /** 스캔 코드로 누를 조합. 없으면 action */
  codes?: string[]
  action?: 'cad' | 'text'
}

const SPECIAL_KEYS: SpecialKey[] = [
  { icon: 'three-keys', label: 'Ctrl + Alt + Del', action: 'cad' },
  { icon: 'view-grid', label: 'Windows 키', codes: ['MetaLeft'] },
  { icon: 'alt-tab', label: 'Alt + Tab', codes: ['AltLeft', 'Tab'] },
  { icon: 'pc', label: 'Win + D (바탕 화면)', codes: ['MetaLeft', 'KeyD'] },
  { icon: 'folder', label: 'Win + E (탐색기)', codes: ['MetaLeft', 'KeyE'] },
  { icon: 'play', label: 'Win + R (실행)', codes: ['MetaLeft', 'KeyR'] },
  { icon: 'lock', label: 'Win + L (잠금)', codes: ['MetaLeft', 'KeyL'] },
  { icon: 'chart', label: 'Ctrl + Shift + Esc (작업 관리자)', codes: ['ControlLeft', 'ShiftLeft', 'Escape'] },
  { icon: 'close-window', label: 'Alt + F4', codes: ['AltLeft', 'F4'] },
  { icon: 'camera', label: 'Print Screen', codes: ['PrintScreen'] },
  { icon: 'text', label: '텍스트 보내기…', action: 'text' },
]

interface KeyboardApi {
  lock?: () => Promise<void>
  unlock?: () => void
}

const keyboardApi = () => (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard

/**
 * Keyboard Lock API: 전체 화면에서 Alt+Tab, Win, Alt+F4, Ctrl+W 같은 키를 브라우저/OS 대신 페이지가 받는다.
 * 보안 컨텍스트(HTTPS, localhost)에서만 노출된다. Ctrl+Alt+Del은 OS가 처리하므로 어떤 방법으로도 가로챌 수 없다.
 */
/** 다른 화면(NPMS 포털 등) 안의 iframe으로 열렸는지 */
const embedded = () => typeof window !== 'undefined' && window.self !== window.top

/**
 * iframe에서는 브라우저가 키보드 잠금을 허용하지 않는다 (최상위 문서만).
 * 바깥 화면(HTTPS)이 지원하면 대신 잠가 달라고 요청한다: {pcmKeyboardLock:'lock'|'unlock', id} → {pcmKeyboardLockResult:id, ok, error}
 * 응답이 없으면(지원하지 않는 화면) false
 */
const parentKeyboardLock = (action: 'lock' | 'unlock') =>
  new Promise<{ ok: boolean; error?: string }>((resolve) => {
    if (!embedded()) {
      resolve({ ok: false })
      return
    }
    const id = Math.random().toString(36).slice(2)
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      resolve({ ok: false })
    }, 1500)
    function onMessage(e: MessageEvent) {
      const d = e.data as { pcmKeyboardLockResult?: string; ok?: boolean; error?: string } | null
      if (e.source !== window.parent || d?.pcmKeyboardLockResult !== id) return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve({ ok: !!d.ok, error: d.error })
    }
    window.addEventListener('message', onMessage)
    window.parent.postMessage({ pcmKeyboardLock: action, id }, '*')
  })

const keyboardLockAvailable = () => typeof window !== 'undefined' && window.isSecureContext && typeof keyboardApi()?.lock === 'function'

type KeyLock = 'off' | 'locked' | 'unavailable'

/** 원격 PC 화면 보기 + 마우스/키보드 조작 (H.264 스트리밍) */
export function RemoteModal({ agentId: initialAgentId, machineName: initialName, userId, onClose }: Props) {
  // PC 목록에서 다른 PC로 바꾸면 그 PC로 다시 연결한다
  const [agentId, setAgentId] = useState(initialAgentId)
  const { pcs, userName } = useContext(RemoteContext)
  const machineName = pcs.find((p) => p.id === agentId)?.name ?? (agentId === initialAgentId ? initialName : agentId.slice(0, 8))
  const [listOpen, setListOpen] = useState(() => {
    try {
      return localStorage.getItem('pcm.remote.pclist') !== '0'
    } catch {
      return true
    }
  })
  // 전체 화면: 왼쪽 가장자리에 마우스를 대면 PC 목록이 잠깐 펼쳐진다 (PiP 버튼은 고정)
  const [edgeOpen, setEdgeOpen] = useState(false)
  const [fsPinned, setFsPinned] = useState(false)
  const edgeTimerRef = useRef(0)
  const openEdge = () => {
    clearTimeout(edgeTimerRef.current)
    setEdgeOpen(true)
  }
  const closeEdgeSoon = () => {
    clearTimeout(edgeTimerRef.current)
    edgeTimerRef.current = window.setTimeout(() => setEdgeOpen(false), 250)
  }
  const toggleList = () => {
    setListOpen((v) => {
      try {
        localStorage.setItem('pcm.remote.pclist', v ? '0' : '1')
      } catch {
        // 무시
      }
      return !v
    })
  }
  const dialogRef = useRef<HTMLDialogElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const sendViewRef = useRef<() => void>(() => {})
  const formatRef = useRef<Format | null>(null)
  const viewOnlyRef = useRef(false)
  const pressedRef = useRef(new Set<string>())
  // 클립보드 동기화: 마지막으로 주고받은 텍스트 (되돌려 보내지 않도록)
  const lastClipRef = useRef<string | null>(null)
  const syncClipRef = useRef<() => void>(() => {})
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
  const [pipOpen, setPipOpen] = useState(false)
  const [textOpen, setTextOpen] = useState(false)
  const [text, setText] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  // 원격 PC 해상도를 이 PC 모니터 해상도에 맞춘다 (RDP처럼). 끄면 원격 원래 해상도
  const [matchResolution, setMatchResolution] = useState(true)
  const matchRef = useRef(true)
  const [keyLock, setKeyLock] = useState<KeyLock>(() => (keyboardLockAvailable() ? 'off' : 'unavailable'))
  const [hint, setHint] = useState<string | null>(null)

  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })

  // 연결은 됐는데 화면이 오래 안 오면(세션 전환 직후 등) 자동으로 다시 연결한다. 수동 '다시 연결'마다 2번까지
  const autoRetryRef = useRef(0)
  useEffect(() => {
    if (phase !== 'connecting') return
    const id = setTimeout(() => {
      if (autoRetryRef.current >= 2) return
      autoRetryRef.current++
      setAttempt((n) => n + 1)
    }, 20000)
    return () => clearTimeout(id)
  }, [phase, attempt])

  // 잠깐 보였다 사라지는 안내 (연결 오류 오버레이와 별개)
  const showHint = (text: string) => setHint(text)
  useEffect(() => {
    if (!hint) return
    const id = setTimeout(() => setHint(null), 6000)
    return () => clearTimeout(id)
  }, [hint])

  // 전체 화면을 벗어나면(Esc 길게 누름 등) 키보드 잠금도 풀린다. 모달을 닫을 때도 정리
  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === stageRef.current
      setFullscreen(active)
      if (!active) {
        keyboardApi()?.unlock?.()
        if (embedded()) void parentKeyboardLock('unlock')
        setKeyLock((s) => (s === 'locked' ? 'off' : s))
      }
      stageRef.current?.focus()
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      keyboardApi()?.unlock?.()
      if (embedded()) void parentKeyboardLock('unlock')
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [])

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

  const changeMatchResolution = (value: boolean) => {
    matchRef.current = value
    setMatchResolution(value)
    sendViewRef.current()
    focusStage()
  }

  const changeViewOnly = (value: boolean) => {
    viewOnlyRef.current = value
    setViewOnly(value)
    focusStage()
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
    const ws = new WebSocket(api.remoteUrl(agentId, userId))
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

    // 대시보드 화면(스테이지)의 실제 픽셀 크기를 알려, 원격이 그 해상도에 맞춰 인코딩하게 한다
    const sendViewSize = () => {
      const stage = stageRef.current
      if (!stage || ws.readyState !== WebSocket.OPEN) return
      const dpr = window.devicePixelRatio || 1
      const width = Math.round(stage.clientWidth * dpr)
      const height = Math.round(stage.clientHeight * dpr)
      // 모니터 해상도(물리 픽셀)는 원격 디스플레이 모드 맞춤(헤드리스 PC)에, 화면 영역 크기(width/height)는 스트림 크기에 쓴다.
      // 실제 모니터가 달린 PC의 해상도를 창 크기로 바꾸면 안 되므로 여기선 항상 모니터 크기를 보낸다
      const screenWidth = Math.round(window.screen.width * dpr)
      const screenHeight = Math.round(window.screen.height * dpr)
      if (width > 0 && height > 0) ws.send(JSON.stringify({ t: 'view', width, height, screenWidth, screenHeight, match: matchRef.current }))
    }
    sendViewRef.current = sendViewSize

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data)
        switch (msg.type) {
          case 'hello': {
            setMonitors(msg.monitors)
            const primary = (msg.monitors as Monitor[]).find((m) => m.primary)
            setMonitor(primary?.index ?? 0)
            setDesktop(msg.desktop ?? null)
            sendViewSize()
            break
          }
          case 'format':
            formatRef.current = msg
            setFormat(msg)
            sink.reset(msg.width, msg.height)
            // 연결은 됐고 첫 프레임을 기다리는 단계임을 구분해 보여 준다 (진단용: 캡처 방식)
            setMessage((m) =>
              m === '연결 중…' || m?.startsWith('화면을 기다리는 중')
                ? `화면을 기다리는 중… (캡처 ${String(msg.capture).toUpperCase()})`
                : m,
            )
            break
          case 'status':
            setDesktop(msg.desktop ?? null)
            if (msg.note === 'resolution-changed') showHint(`원격 해상도를 ${msg.width}×${msg.height}(으)로 맞췄습니다.`)
            else if (msg.note === 'resolution-failed') showHint(`해상도 맞춤 실패: ${msg.message ?? '지원하지 않는 모드'}`)
            else if (msg.note === 'headless') showHint('원격 PC에 모니터가 없어 가상 모니터를 준비합니다… (처음이면 드라이버 설치로 몇 초 걸립니다)')
            else if (msg.note === 'virtual-monitor') showHint('가상 모니터를 켰습니다. 세션이 끝나면 자동으로 꺼집니다.')
            else if (msg.note === 'reattaching') {
              // 로그인 등으로 원격 세션이 바뀜 → 서버가 새 세션에 다시 잇는 중
              setPhase('connecting')
              setMessage('로그인/세션 전환 중… 다시 연결하는 중')
            }
            break
          case 'cursor':
            setCursor({ x: msg.x, y: msg.y, visible: msg.visible })
            break
          case 'clipboard':
            // 원격 클립보드가 바뀌면 이 PC 클립보드에 반영 (보안 컨텍스트에서만, 창에 포커스가 있어야 함)
            if (typeof msg.text === 'string' && msg.text !== lastClipRef.current) {
              lastClipRef.current = msg.text
              navigator.clipboard?.writeText?.(msg.text).catch(() => {})
            }
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

    // 창 크기가 바뀌면 해상도를 다시 맞춘다 (너무 자주 보내지 않게 약간 지연)
    let resizeTimer = 0
    const onResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(sendViewSize, 600)
    }
    const stage = stageRef.current
    const observer = stage ? new ResizeObserver(onResize) : null
    if (stage && observer) observer.observe(stage)
    // 창에 포커스가 있을 때 이 PC 클립보드를 원격으로 보낸다 (복사 직후 바로 붙여넣을 수 있게)
    const clipTimer = window.setInterval(() => {
      if (document.hasFocus()) syncClipRef.current()
    }, 1500)

    return () => {
      clearInterval(statsTimer)
      clearInterval(clipTimer)
      clearTimeout(resizeTimer)
      observer?.disconnect()
      ws.onmessage = null
      ws.onclose = null
      ws.close()
      sink.close()
      wsRef.current = null
      setFormat(null)
      formatRef.current = null
    }
  }, [agentId, userId, attempt, useWebCodecs])

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
    focusStage()
  }

  const changeQuality = (index: number) => {
    setQuality(index)
    send({ t: 'quality', bitrate: QUALITIES[index].bitrate })
    focusStage()
  }

  const toggleFullscreen = async () => {
    // 모달 <dialog>는 이미 최상위 레이어라 전체 화면 요청이 무시된다 → 화면 영역(stage)을 전체 화면으로
    const stage = stageRef.current
    if (!stage) return
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
        return
      }
      await stage.requestFullscreen()
    } catch (err) {
      showHint(`전체 화면을 전환하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
      stage.focus()
      return
    }

    // 전체 화면에서만 키보드 잠금이 가능: Alt+Tab, Win, Alt+F4, Ctrl+W 등이 로컬 대신 원격으로 간다
    // 다른 화면(NPMS 포털 등) 안의 iframe이면 HTTPS여도 브라우저가 키보드 잠금을 허용하지 않는다 (최상위 창만)
    // → 바깥 화면이 대신 잠가 주면 그것으로 (바깥도 HTTPS여야 함)
    const inFrame = embedded()
    if (inFrame) {
      const result = await parentKeyboardLock('lock')
      if (result.ok) {
        setKeyLock('locked')
        showHint('키보드 잠금: Alt+Tab·Win·Alt+F4가 원격으로 전달됩니다. 종료하려면 Esc를 길게 누르거나 ⛶ 버튼을 누르세요.')
        stage.focus()
        return
      }
      if (result.error) {
        showHint(`키보드 잠금 실패(바깥 화면): ${result.error}. 새 창으로 열면 됩니다. 지금은 위 아이콘으로 보낼 수 있습니다.`)
        stage.focus()
        return
      }
    }
    if (keyLock === 'unavailable' || inFrame) {
      // HTTP 접속: 브라우저가 Keyboard Lock API를 노출하지 않는다 → HTTPS 주소를 안내
      let https: string | null = null
      try {
        https = (await api.installInfo()).httpsUrl
      } catch {
        // 안내만 생략
      }
      showHint(
        inFrame
          ? `다른 화면 안에 열린 대시보드에서는 Alt+Tab·Win 키를 직접 보낼 수 없습니다. 새 창으로 여세요: ${https ?? location.origin}  (상단 '새 창에서 열기'). 지금은 위 아이콘으로 보낼 수 있습니다.`
          : https
          ? `Alt+Tab·Win 키를 직접 누르려면 HTTPS로 접속하세요: ${https}  (인증서 경고가 뜨면 'PC 추가' 창의 인증서 설치 도구를 한 번 실행). 지금은 위 아이콘으로 보낼 수 있습니다.`
          : 'Alt+Tab·Win 키를 직접 누르려면 HTTPS(또는 localhost)로 접속해야 합니다. 지금은 위 아이콘으로 보낼 수 있습니다.',
      )
    } else {
      try {
        await keyboardApi()!.lock!()
        setKeyLock('locked')
        showHint('키보드 잠금: Alt+Tab·Win·Alt+F4가 원격으로 전달됩니다. 종료하려면 Esc를 길게 누르거나 ⛶ 버튼을 누르세요.')
      } catch (err) {
        setKeyLock('off')
        showHint(`키보드 잠금 실패: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    stage.focus()
  }

  // 헤더/PiP 버튼을 누르면 포커스가 버튼으로 가므로 키 입력이 계속 원격으로 가게 되돌린다
  const focusStage = () => stageRef.current?.focus()

  // 이 PC 클립보드를 원격으로 보낸다 (보기 전용이 아닐 때, 보안 컨텍스트에서만 가능)
  const syncClipboardToRemote = () => {
    if (viewOnlyRef.current) return
    navigator.clipboard
      ?.readText?.()
      .then((text) => {
        if (typeof text === 'string' && text && text !== lastClipRef.current) {
          lastClipRef.current = text
          send({ t: 'clip', text })
        }
      })
      .catch(() => {})
  }
  syncClipRef.current = syncClipboardToRemote

  // PC 목록에서 다른 PC 선택 (상태·사용 중 규칙은 탐색기와 같다)
  const switchTo = (id: string) => {
    if (id === agentId) return
    const pc = pcs.find((p) => p.id === id)
    if (!pc || !pc.online) return
    if (pc.status?.status === 'forbidden') {
      showHint(`${pc.name}: 사용 금지 상태라 원격조작할 수 없습니다.${pc.status.note ? ` (${pc.status.note})` : ''}`)
      return
    }
    if (pc.inUseBy && pc.inUseBy !== (userId ?? 'anonymous')) {
      showHint(`${pc.name}: ${userName(pc.inUseBy)}님이 원격조작 중입니다.`)
      return
    }
    if (pc.status?.status === 'testing' && !window.confirm(`'${pc.name}'은(는) '테스트 중' 상태입니다.${pc.status.note ? ` (${pc.status.note})` : ''}\n그래도 원격조작할까요?`)) return
    releaseKeys()
    setAgentId(id)
    setPipOpen(false)
    setEdgeOpen(false)
    focusStage()
  }

  const pcList = (
    <ul className="remote-pclist-items">
      {pcs.map((pc, i) => {
        const showGroup = i === 0 || pcs[i - 1].group !== pc.group
        const busy = !!pc.inUseBy && pc.inUseBy !== (userId ?? 'anonymous')
        const cls = ['remote-pc', pc.id === agentId ? 'current' : '', pc.online ? '' : 'offline', busy || pc.status?.status === 'forbidden' ? 'blocked' : ''].filter(Boolean).join(' ')
        return (
          <li key={pc.id}>
            {showGroup && <div className="remote-pc-group">📂 {pc.group}</div>}
            <button type="button" className={cls} disabled={!pc.online} title={pc.name} onClick={() => switchTo(pc.id)}>
              <span className={`dot ${pc.online ? 'on' : 'off'}`} />
              <span className="ellipsis">{pc.name}</span>
              {pc.status && pc.status.status !== 'available' && <span className={`status-badge ${pc.status.status}`}>{PC_STATUS_LABEL[pc.status.status]}</span>}
              {busy && <span className="remote-pc-busy" title={`${userName(pc.inUseBy!)} 사용 중`}>●</span>}
            </button>
          </li>
        )
      })}
      {pcs.length === 0 && <li className="muted small remote-pc-empty">PC 없음</li>}
    </ul>
  )

  const pressSpecial = (k: SpecialKey) => {
    if (k.action === 'cad') {
      api.sendCtrlAltDel(agentId).catch((err: unknown) => showHint(err instanceof Error ? err.message : String(err)))
    } else if (k.action === 'text') {
      setTextOpen(true)
      return
    } else if (k.codes) {
      sendInput({ t: 'combo', codes: k.codes })
    }
    setPipOpen(false)
    focusStage()
  }

  const keysDisabled = viewOnly || phase !== 'live'
  const renderSpecialKeys = (className: string) =>
    SPECIAL_KEYS.map((k) => (
      <button key={k.label} type="button" className={className} title={k.label} aria-label={k.label} disabled={keysDisabled} onClick={() => pressSpecial(k)}>
        <Icon name={k.icon} size={18} />
      </button>
    ))

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
          {keyLock === 'locked' && <span className="remote-badge ok">키보드 잠금</span>}
        </span>
        <span className="remote-actions">
          <button type="button" className={`icon remote-key${listOpen ? ' active' : ''}`} title="PC 목록 (빠른 전환)" aria-pressed={listOpen} onClick={toggleList}>
            <Icon name="pc" size={18} />
          </button>
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
          <label className="remote-toggle" title="원격 PC 해상도를 이 PC 모니터 해상도에 맞춥니다 (세션 종료 시 복원)">
            <input type="checkbox" checked={matchResolution} onChange={(e) => changeMatchResolution(e.target.checked)} /> 해상도 맞춤
          </label>
          <label className="remote-toggle">
            <input type="checkbox" checked={viewOnly} onChange={(e) => changeViewOnly(e.target.checked)} /> 보기 전용
          </label>
          {/* 로컬에서 가로채는 특수 키 (창 모드: 상단바에 아이콘) */}
          <span className="remote-keys" role="group" aria-label="특수 키">
            {renderSpecialKeys('icon remote-key')}
          </span>
          <button
            type="button"
            className="icon"
            title={
              keyLock === 'unavailable'
                ? '전체 화면 (Alt+Tab·Win 키 전달은 HTTPS 접속에서만 가능)'
                : '전체 화면 + 키보드 잠금 (Alt+Tab·Win·Alt+F4를 원격으로 전달)'
            }
            onClick={() => void toggleFullscreen()}
          >
            <Icon name="fullscreen" size={18} />
          </button>
          <button type="button" className="icon" aria-label="닫기" onClick={() => dialogRef.current?.close()}>
            ✕
          </button>
        </span>
      </div>

      <div className="remote-body">
      {listOpen && !fullscreen && (
        <aside className="remote-pclist">
          <div className="remote-pclist-title small muted">PC 목록 · 클릭하면 전환</div>
          {pcList}
        </aside>
      )}
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
        onFocus={syncClipboardToRemote}
        onBlur={releaseKeys}
      >
        {useWebCodecs ? <canvas ref={canvasRef} className="remote-surface" /> : <video ref={videoRef} className="remote-surface" muted playsInline />}

        {viewOnly && cursor?.visible && format && <RemoteCursor x={cursor.x} y={cursor.y} stage={stageSize} format={format} />}

        {/* 전체 화면에서는 헤더가 안 보이므로 반투명 PiP 도구를 띄운다. 키보드 아이콘을 누르면 특수 키가 펼쳐진다 */}
        {fullscreen && (
          <div
            className={`remote-pip${pipOpen ? ' open' : ''}`}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <button type="button" className={`icon remote-key${fsPinned ? ' active' : ''}`} title={fsPinned ? 'PC 목록 고정 해제 (왼쪽 가장자리에 마우스를 대면 표시)' : 'PC 목록 고정 (왼쪽 가장자리에 마우스를 대도 표시)'} aria-pressed={fsPinned} onClick={() => setFsPinned((v) => !v)}>
              <Icon name="pc" size={18} />
            </button>
            <button type="button" className="icon remote-key" title="특수 키" aria-expanded={pipOpen} onClick={() => setPipOpen((o) => !o)}>
              <Icon name="keyboard" size={18} />
            </button>
            {pipOpen && <span className="remote-pip-keys">{renderSpecialKeys('icon remote-key')}</span>}
            <button type="button" className="icon remote-key" title="전체 화면 종료" onClick={() => void toggleFullscreen()}>
              <Icon name="fullscreen-exit" size={18} />
            </button>
          </div>
        )}

        {/* 전체 화면 왼쪽 가장자리 호버 영역 */}
        {fullscreen && !fsPinned && !edgeOpen && (
          <div className="remote-edge-hot" onPointerEnter={openEdge} onPointerDown={(e) => e.stopPropagation()} title="PC 목록" />
        )}

        {fullscreen && (fsPinned || edgeOpen) && (
          <aside
            className={`remote-pclist overlay${fsPinned ? ' pinned' : ''}`}
            onPointerEnter={openEdge}
            onPointerLeave={() => {
              if (!fsPinned) closeEdgeSoon()
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="remote-pclist-title small">PC 목록 · 클릭하면 전환{fsPinned ? ' · 고정됨' : ''}</div>
            {pcList}
          </aside>
        )}

        {hint && <div className="remote-hint">{hint}</div>}

        {message && (
          <div className="remote-overlay">
            <p>{message}</p>
            {phase === 'closed' && (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  autoRetryRef.current = 0
                  setAttempt((n) => n + 1)
                }}
              >
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
      </div>

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
