import { type ReactNode, useEffect, useRef, useState } from 'react'
import { formatSeconds } from './resultCsv'

// ReplayKit 결과 화면과 같은 단축키 (e.code 기준이라 한글 입력 상태에서도 동작)
//   Space 재생/정지 · A/D 뒤로/앞으로(이동 간격) · S/W 배속 내림/올림(x0=정지) · Q/E 한 프레임 · F/R 다음/이전 영상
const SPEEDS = [0, 1, 2, 4, 8, 10]
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
  /** 영상 대신 보여 줄 안내 (재생용 영상 만드는 중 등) */
  waiting?: string | null
  /** ffmpeg가 읽은 길이 (브라우저가 길이를 모르는 영상: Infinity) */
  durationHint?: number | null
  /** ffmpeg가 읽은 fps (한 프레임 이동 간격) */
  fps?: number | null
}

export function VideoTransport({ src, videoRef, keysEnabled, onTime, onLoaded, onSwitch, extra, error, waiting, durationHint, fps }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [jump, setJump] = useState(1)
  const [time, setTime] = useState(0)
  const [mediaDuration, setMediaDuration] = useState(0)
  // 브라우저가 길이를 모르면(Infinity) ffmpeg가 읽은 길이
  const duration = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : (durationHint ?? 0)
  const [osd, setOsd] = useState<string | null>(null)
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
    video.currentTime = Math.max(0, duration > 0 ? Math.min(duration - 0.05, target) : target)
  }

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
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
              setTime(e.currentTarget.currentTime)
              onTime(e.currentTarget.currentTime)
            }}
            onLoadedMetadata={(e) => {
              const video = e.currentTarget
              video.playbackRate = speed || 1
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
        {osd && <div className="rv-osd">{osd}</div>}
        {error && <div className="rv-video-error">{error}</div>}
      </div>
      <input
        className="rv-seek"
        type="range"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(time, duration || 0)}
        onChange={(e) => {
          if (videoRef.current) videoRef.current.currentTime = Number(e.target.value)
        }}
      />
      <div className="rv-transport">
        <button type="button" onMouseDown={noFocus} onClick={togglePlay} title="재생/일시정지 (Space)">{playing ? '❚❚' : '▶'}</button>
        <button type="button" onMouseDown={noFocus} onClick={() => stepFrame(-1)} title="이전 프레임 (Q)">⏮</button>
        <button type="button" onMouseDown={noFocus} onClick={() => stepFrame(1)} title="다음 프레임 (E)">⏭</button>
        <span className="rv-time mono">{formatSeconds(time)} / {formatSeconds(duration)}</span>
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
        <span className="rv-keys muted small" title="Space 재생/정지 · A/D 이동 · S/W 배속 · Q/E 프레임 · F/R 영상 전환">⌨ 단축키</span>
      </div>
    </div>
  )
}
