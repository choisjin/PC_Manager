// 에이전트가 보낸 H.264 프레임을 화면에 그리는 두 가지 방법
//  - WebCodecs: 지연이 가장 적다. 보안 컨텍스트(HTTPS, localhost)에서만 쓸 수 있다
//  - MSE: fMP4로 감싸 <video>로 재생. http://서버IP 처럼 보안 컨텍스트가 아닐 때 쓴다

import { codecString, findParameterSets, splitNalUnits, type ParameterSets } from './h264'
import { initSegment, mediaSegment, TIMESCALE } from './mp4'

export interface EncodedFrame {
  data: Uint8Array
  isKey: boolean
  /** 마이크로초 */
  timestamp: number
}

export interface VideoSink {
  readonly kind: 'webcodecs' | 'mse'
  /** 해상도가 바뀌면 새 키 프레임부터 다시 시작한다 */
  reset(width: number, height: number): void
  /** false면 키 프레임이 필요하다 (디코더 오류 등) */
  push(frame: EncodedFrame): boolean
  close(): void
}

export const webCodecsAvailable = () => typeof window !== 'undefined' && window.isSecureContext && 'VideoDecoder' in window

export class WebCodecsSink implements VideoSink {
  readonly kind = 'webcodecs'
  private decoder: VideoDecoder | null = null
  private codec = ''
  private needKey = true
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  }

  reset(width: number, height: number) {
    this.canvas.width = width
    this.canvas.height = height
    this.closeDecoder()
    this.needKey = true
  }

  push(frame: EncodedFrame): boolean {
    if (this.needKey && !frame.isKey) return false

    if (frame.isKey) {
      const ps = findParameterSets(splitNalUnits(frame.data))
      const codec = ps ? codecString(ps.sps) : this.codec
      if (!this.decoder || this.decoder.state !== 'configured' || codec !== this.codec) {
        this.closeDecoder()
        this.codec = codec
        this.decoder = new VideoDecoder({
          output: (f) => this.draw(f),
          error: (e) => {
            console.warn('원격 화면 디코딩 오류', e)
            this.needKey = true
          },
        })
        // description 없이 설정하면 Annex B(시작 코드) 형식으로 받는다
        this.decoder.configure({ codec, optimizeForLatency: true })
      }
    }
    if (!this.decoder || this.decoder.state !== 'configured') {
      this.needKey = true
      return false
    }
    // 디코더가 밀리면 버리고 다음 키 프레임부터 다시
    if (this.decoder.decodeQueueSize > 30) {
      this.closeDecoder()
      this.needKey = true
      return false
    }

    this.decoder.decode(new EncodedVideoChunk({ type: frame.isKey ? 'key' : 'delta', timestamp: frame.timestamp, data: frame.data }))
    this.needKey = false
    return true
  }

  private draw(frame: VideoFrame) {
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth
      this.canvas.height = frame.displayHeight
    }
    this.ctx?.drawImage(frame, 0, 0)
    frame.close()
  }

  private closeDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = null
  }

  close() {
    this.closeDecoder()
  }
}

/**
 * MSE 재생. 화면이 바뀔 때만 프레임이 오므로 실제 시각 대신 1/30초 간격의 연속 시각을 붙인다.
 * 데이터가 끊기면 마지막 프레임에서 멈춰 있다가 새 프레임이 붙으면 바로 이어서 재생된다.
 * 뒤처지면 최신 위치로 건너뛰어 지연이 쌓이지 않게 한다.
 */
export class MseSink implements VideoSink {
  readonly kind = 'mse'
  private static readonly FRAME = TIMESCALE / 30
  private mediaSource: MediaSource | null = null
  private buffer: SourceBuffer | null = null
  private objectUrl = ''
  private queue: Uint8Array[] = []
  private width = 0
  private height = 0
  private params: ParameterSets | null = null
  private sequence = 0
  private decodeTime = 0
  private needKey = true
  private lastTrim = 0

  private readonly video: HTMLVideoElement

  constructor(video: HTMLVideoElement) {
    this.video = video
    video.muted = true
    video.playsInline = true
  }

  reset(width: number, height: number) {
    this.width = width
    this.height = height
    this.teardown()
    this.needKey = true
  }

  push(frame: EncodedFrame): boolean {
    if (this.needKey && !frame.isKey) return false
    const units = splitNalUnits(frame.data)

    if (frame.isKey) {
      const ps = findParameterSets(units)
      if (ps && (!this.params || !sameBytes(ps.sps, this.params.sps) || !sameBytes(ps.pps, this.params.pps) || !this.mediaSource)) {
        this.teardown()
        this.params = ps
        this.open(ps)
      }
    }
    if (!this.params || !this.mediaSource) {
      this.needKey = true
      return false
    }

    this.enqueue(mediaSegment(++this.sequence, this.decodeTime, MseSink.FRAME, units, frame.isKey))
    this.decodeTime += MseSink.FRAME
    this.needKey = false
    return true
  }

  private open(ps: ParameterSets) {
    const mediaSource = new MediaSource()
    this.mediaSource = mediaSource
    this.objectUrl = URL.createObjectURL(mediaSource)
    this.video.src = this.objectUrl
    this.sequence = 0
    this.decodeTime = 0
    const init = initSegment(this.width, this.height, ps)
    mediaSource.addEventListener(
      'sourceopen',
      () => {
        if (this.mediaSource !== mediaSource) return
        try {
          const buffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${codecString(ps.sps)}"`)
          buffer.mode = 'segments'
          buffer.addEventListener('updateend', () => this.onUpdateEnd())
          buffer.addEventListener('error', () => (this.needKey = true))
          this.buffer = buffer
          this.queue.unshift(init)
          this.flush()
          void this.video.play().catch(() => {})
        } catch (e) {
          console.warn('MSE 초기화 실패', e)
          this.needKey = true
        }
      },
      { once: true },
    )
  }

  private enqueue(segment: Uint8Array) {
    // 네트워크가 몰리면 큐가 쌓인다 → 버리고 다음 키 프레임부터 (호출자가 키 프레임 요청)
    if (this.queue.length > 60) {
      this.teardown()
      this.needKey = true
      return
    }
    this.queue.push(segment)
    this.flush()
  }

  private flush() {
    const buffer = this.buffer
    if (!buffer || buffer.updating || this.queue.length === 0) return
    const next = this.queue.shift()!
    try {
      buffer.appendBuffer(next as BufferSource)
    } catch (e) {
      console.warn('MSE 추가 실패', e)
      this.teardown()
      this.needKey = true
    }
  }

  private onUpdateEnd() {
    const buffer = this.buffer
    const video = this.video
    if (!buffer) return

    const ranges = video.buffered
    if (ranges.length > 0) {
      const end = ranges.end(ranges.length - 1)
      // 최신 프레임에서 너무 뒤처지면 건너뛴다
      if (end - video.currentTime > 0.3) video.currentTime = Math.max(ranges.start(ranges.length - 1), end - 0.03)
      if (video.paused) void video.play().catch(() => {})

      // 지나간 구간은 주기적으로 지워 메모리를 아낀다
      if (this.queue.length === 0 && video.currentTime - this.lastTrim > 30 && video.currentTime > 10) {
        this.lastTrim = video.currentTime
        buffer.remove(0, video.currentTime - 5)
        return
      }
    }
    this.flush()
  }

  private teardown() {
    this.queue = []
    this.buffer = null
    this.params = null
    const ms = this.mediaSource
    this.mediaSource = null
    if (ms && ms.readyState === 'open') {
      try {
        ms.endOfStream()
      } catch {
        // 이미 닫힘
      }
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = ''
    }
    this.lastTrim = 0
  }

  close() {
    this.teardown()
    this.video.removeAttribute('src')
    this.video.load()
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
