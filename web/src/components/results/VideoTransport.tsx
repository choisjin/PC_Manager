import { type ReactNode, useEffect, useRef, useState } from 'react'
import { formatSeconds } from './resultCsv'

// ReplayKit 결과 화면과 같은 단축키 (e.code 기준이라 한글 입력 상태에서도 동작)
//   Space 재생/정지 · A/D 뒤로/앞으로(이동 간격) · S/W 배속 내림/올림(x0=정지) · Q/E 한 프레임 · F/R 다음/이전 영상
const SPEEDS = [0, 1, 2, 4, 8, 10]
// '단축키' 버튼을 누르면 펼치는 목록
const KEY_HELP: [string, string][] = [
  ['Space', '재생 / 일시정지'],
  ['A / D', '뒤로 / 앞으로 (이동 간격 × 배속)'],
  ['S / W', '배속 내림 / 올림 (x0 = 정지)'],
  ['Q / E', '이전 / 다음 프레임'],
  ['F / R', '다음 / 이전 영상 (영상이 여럿일 때)'],
]
const JUMPS = [0.5, 1, 2, 5, 10]

interface Props {
  src: string | null
  /** 영상 요소 (부모가 위치 이동·현재 위치 읽기에 쓴다) */
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** 단축키를 받을지 (대화 상자가 열려 있으면 false) */
  keysEnabled: boolean
  onTime: (seconds: number) => void
  onLoaded: (duration: number) => void
  onSwitch?: (step: 1 | -1) => void
  /** 도구 모음 오른쪽 추가 버튼 (자르기 등) */
  extra?: ReactNode
  error?: string | null
  /** 영상 대신 보여 줄 안내 (재생용 영상 만드는 중·진행 등) */
  waiting?: ReactNode
  /** ffmpeg가 읽은 길이 (브라우저가 길이를 모르는 영상: Infinity) */
  durationHint?: number | null
  /** ffmpeg가 읽은 fps (한 프레임 이동 간격) */
  fps?: number | null
  /** 영상 위에 겹쳐 그릴 것 (이미지 찾기 크롭 등) */
  overlay?: ReactNode
  /** 탐색 막대 위에 표시할 구간 (초) */
  marks?: { start: number; end: number }[]
  /** 이 구간(초)만 보여 준다: 탐색 막대·시간은 0~구간 길이, 재생도 그 안에서 (자르기 미리보기) */
  clip?: { start: number; end: number } | null
}

export function VideoTransport({ src, videoRef, keysEnabled, onTime, onLoaded, onSwitch, extra, error, waiting, durationHint, fps, overlay, marks, clip }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [jump, setJump] = useState(1)
  const [time, setTime] = useState(0)
  const [mediaDuration, setMediaDuration] = useState(0)
  // 브라우저가 길이를 모르면(Infinity) ffmpeg가 읽은 길이
  const duration = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : (durationHint ?? 0)
  // 보여 주는 범위: 구간 미리보기면 그 구간, 아니면 영상 전체
  const lo = clip?.start ?? 0
  const hi = clip ? clip.end : duration
  const [osd, setOsd] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const helpRef = useRef<HTMLSpanElement>(null)
  // 단축키 목록: 바깥을 누르거나 Esc면 닫는다 (Esc가 결과 확인 창을 닫지 않게 먼저 받는다)
  useEffect(() => {
    if (!helpOpen) return
    const onDown = (e: MouseEvent) => {
      if (!helpRef.current?.contains(e.target as Node)) setHelpOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setHelpOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [helpOpen])
  const osdTimer = useRef(0)
  const frameRef = useRef(1 / 30)

  const showOsd = (text: string) => {
    setOsd(text)
    window.clearTimeout(osdTimer.current)
    osdTimer.current = window.setTimeout(() => setOsd(null), 700)
  }

  // 영상이 바뀌면 이전 영상의 위치·길이를 지운다
  useEffect(() => {
    setTime(0)
    setMediaDuration(0)
  }, [src])

  // 구간 미리보기: 구간이 바뀌면 처음으로 (멈춘 채), 재생은 구간 끝에서 멈춘다 (timeupdate는 0.25초 간격이라 화면 갱신마다 본다)
  const clipStart = clip?.start ?? null
  const clipEnd = clip?.end ?? null
  useEffect(() => {
    const video = videoRef.current
    if (!video || clipStart === null) return
    video.pause()
    if (video.readyState >= 1) video.currentTime = clipStart
  }, [clipStart, clipEnd, src, videoRef])
  useEffect(() => {
    const video = videoRef.current
    if (!video || !playing || clipEnd === null) return
    let frame = 0
    const check = () => {
      if (video.currentTime >= clipEnd) {
        video.pause()
        video.currentTime = clipEnd
        return
      }
      frame = requestAnimationFrame(check)
    }
    frame = requestAnimationFrame(check)
    return () => cancelAnimationFrame(frame)
  }, [playing, clipEnd, videoRef])

  // 프레임 길이: ffmpeg가 읽은 fps, 없으면 재생 중 실제 프레임 간격의 중앙값 (기본 30fps)
  useEffect(() => {
    if (fps) frameRef.current = 1 / fps
  }, [fps, src])
  useEffect(() => {
    const video = videoRef.current as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number }) | null
    if (!video?.requestVideoFrameCallback) return
    const deltas: number[] = []
    let last = -1
    let stop = false
    const tick = (_: number, meta: { mediaTime: number }) => {
      if (stop) return
      if (!fps && last >= 0 && video.playbackRate === 1) {
        const d = meta.mediaTime - last
        if (d > 0.005 && d < 0.2) deltas.push(d)
        if (deltas.length >= 15) {
          frameRef.current = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)]
          deltas.length = 0
        }
      }
      last = meta.mediaTime
      video.requestVideoFrameCallback!(tick)
    }
    video.requestVideoFrameCallback(tick)
    return () => {
      stop = true
    }
  }, [src, videoRef, fps])

  const applySpeed = (next: number) => {
    const video = videoRef.current
    if (!video) return
    setSpeed(next)
    if (next === 0) {
      video.pause()
      showOsd('정지 (x0)')
    } else {
      video.playbackRate = next
      if (video.paused) void video.play().catch(() => {})
      showOsd(`x${next}`)
    }
  }

  const seekBy = (seconds: number) => {
    const video = videoRef.current
    if (!video) return
    const target = video.currentTime + seconds
    video.currentTime = Math.max(lo, hi > 0 ? Math.min(hi - (clip ? 0 : 0.05), target) : target)
  }

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      // 구간 끝에서 다시 누르면 구간 처음부터
      if (clip && video.currentTime >= clip.end - 0.05) video.currentTime = clip.start
      if (speed === 0) applySpeed(1)
      else void video.play().catch(() => {})
      showOsd('재생')
    } else {
      video.pause()
      showOsd('일시정지')
    }
  }

  const stepFrame = (dir: 1 | -1) => {
    const video = videoRef.current
    if (!video) return
    video.pause()
    seekBy(dir * frameRef.current * Math.max(1, speed))
    showOsd(dir > 0 ? '다음 프레임' : '이전 프레임')
  }

  useEffect(() => {
    if (!keysEnabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      const step = jump * Math.max(1, speed)
      const actions: Record<string, () => void> = {
        Space: () => { if (!e.repeat) togglePlay() },
        KeyA: () => { seekBy(-step); showOsd(`◀ ${step}초`) },
        KeyD: () => { seekBy(step); showOsd(`${step}초 ▶`) },
        KeyS: () => applySpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]),
        KeyW: () => applySpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(1, SPEEDS.indexOf(speed) + 1))]),
        KeyQ: () => stepFrame(-1),
        KeyE: () => stepFrame(1),
        KeyF: () => { if (onSwitch) { onSwitch(1); showOsd('다음 영상') } },
        KeyR: () => { if (onSwitch) { onSwitch(-1); showOsd('이전 영상') } },
      }
      const action = actions[e.code]
      if (!action) return
      e.preventDefault()
      e.stopPropagation()
      action()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const fullscreen = () => {
    const wrap = wrapRef.current
    if (!wrap) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void wrap.requestFullscreen().catch(() => {})
  }

  // 버튼이 포커스를 가져가 Space가 버튼을 누르지 않게
  const noFocus = (e: React.MouseEvent) => e.preventDefault()

  return (
    <div className="rv-video" ref={wrapRef}>
      <div className="rv-video-stage">
        {src ? (
          <video
            ref={videoRef}
            key={src}
            src={src}
            preload="auto"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => {
              const video = e.currentTarget
              // 구간 미리보기: 구간 밖으로 가면(표에서 다른 스텝을 눌러 이동 등) 구간 안으로
              if (clip && (video.currentTime < clip.start - 0.05 || video.currentTime > clip.end + 0.05)) {
                video.pause()
                video.currentTime = video.currentTime < clip.start ? clip.start : clip.end
                return
              }
              setTime(video.currentTime)
              onTime(video.currentTime)
            }}
            onLoadedMetadata={(e) => {
              const video = e.currentTarget
              video.playbackRate = speed || 1
              if (clip) video.currentTime = clip.start
              if (!Number.isFinite(video.duration) && !durationHint) {
                // 길이가 없는 영상(브라우저 녹화 webm 등): 끝으로 한 번 보내면 브라우저가 길이를 알아낸다
                const restore = () => {
                  video.removeEventListener('durationchange', restore)
                  if (Number.isFinite(video.duration)) setMediaDuration(video.duration)
                  video.currentTime = 0
                  onLoaded(video.duration)
                }
                video.addEventListener('durationchange', restore)
                video.currentTime = 1e9
                return
              }
              setMediaDuration(video.duration)
              onLoaded(video.duration)
            }}
            onDurationChange={(e) => {
              if (Number.isFinite(e.currentTarget.duration)) setMediaDuration(e.currentTarget.duration)
            }}
            onClick={togglePlay}
          />
        ) : (
          <div className="rv-video-empty muted">{waiting ?? '영상이 없습니다'}</div>
        )}
        {src && overlay}
        {osd && <div className="rv-osd">{osd}</div>}
        {error && <div className="rv-video-error">{error}</div>}
      </div>
      {!clip && marks && marks.length > 0 && duration > 0 && (
        <div className="rv-seek-marks" aria-hidden>
          {marks.map((m) => (
            <span key={m.start} style={{ left: `${(m.start / duration) * 100}%`, width: `max(2px, ${((m.end - m.start) / duration) * 100}%)` }} />
          ))}
        </div>
      )}
      <input
        className={`rv-seek${clip ? ' clip' : ''}`}
        type="range"
        min={0}
        max={Math.max(0, hi - lo)}
        step={0.01}
        value={Math.max(0, Math.min(time - lo, hi - lo))}
        onChange={(e) => {
          if (videoRef.current) videoRef.current.currentTime = lo + Number(e.target.value)
        }}
      />
      <div className="rv-transport">
        <button type="button" onMouseDown={noFocus} onClick={togglePlay} title="재생/일시정지 (Space)">{playing ? '❚❚' : '▶'}</button>
        <button type="button" onMouseDown={noFocus} onClick={() => stepFrame(-1)} title="이전 프레임 (Q)">⏮</button>
        <button type="button" onMouseDown={noFocus} onClick={() => stepFrame(1)} title="다음 프레임 (E)">⏭</button>
        <span className="rv-time mono">{formatSeconds(Math.max(0, time - lo))} / {formatSeconds(Math.max(0, hi - lo))}</span>
        {clip && <span className="rv-clip-tag small" title="자를 구간만 보여 주는 중 (자르기 종료하면 영상 전체)">✂ 구간</span>}
        <label className="rv-mini" title="A/D 이동 간격">
          이동
          <select value={jump} onChange={(e) => setJump(Number(e.target.value))}>
            {JUMPS.map((j) => <option key={j} value={j}>{j}초</option>)}
          </select>
        </label>
        <label className="rv-mini" title="배속 (S/W)">
          배속
          <select value={speed} onChange={(e) => applySpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => <option key={s} value={s}>x{s}</option>)}
          </select>
        </label>
        <span className="rv-spacer" />
        {extra}
        <button type="button" onMouseDown={noFocus} onClick={fullscreen} title="전체 화면">⛶</button>
        <span className="rv-keys" ref={helpRef}>
          <button type="button" className={`small${helpOpen ? ' active' : ''}`} onMouseDown={noFocus} onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen} title="단축키 보기">
            ⌨ 단축키
          </button>
          {helpOpen && (
            <span className="rv-keys-pop" role="dialog" aria-label="단축키">
              {KEY_HELP.map(([k, d]) => (
                <span key={k} className="rv-keys-row"><kbd>{k}</kbd><span>{d}</span></span>
              ))}
              <span className="rv-keys-note">한글 입력 상태에서도 동작 · 입력 칸에 글자를 쓰는 중에는 꺼짐</span>
            </span>
          )}
        </span>
      </div>
    </div>
  )
}
