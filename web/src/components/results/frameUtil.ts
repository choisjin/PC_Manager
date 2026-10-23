import { useLayoutEffect, useRef, useState } from 'react'
import type { Rect } from './imageSearchState'

// 결과 확인의 영상 위 표시·영역 고르기 창이 함께 쓰는 도구 (이미지 찾기 · 영상 분석)

/** 영상 크기에 대한 비율 사각형 [x0, y0, x1, y1] (크기가 다른 영상에도 같은 자리) */
export type Box = [number, number, number, number]

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 사각형을 배율대로 (프레임 안으로) */
export function scaleRect(r: Rect, sx: number, sy: number, frame: { width: number; height: number }): Rect {
  const x = clamp(Math.round(r.x * sx), 0, frame.width - 1)
  const y = clamp(Math.round(r.y * sy), 0, frame.height - 1)
  return { x, y, w: clamp(Math.round(r.w * sx), 1, frame.width - x), h: clamp(Math.round(r.h * sy), 1, frame.height - y) }
}

/** 프레임 픽셀 사각형 → 비율 */
export function rectToBox(r: Rect, width: number, height: number): Box {
  const f = (v: number) => Math.round(v * 10000) / 10000
  return [f(r.x / width), f(r.y / height), f((r.x + r.w) / width), f((r.y + r.h) / height)]
}

/** 비율 → 프레임 픽셀 사각형 (프레임 안으로) */
export function boxToRect(b: Box, width: number, height: number): Rect {
  const x = clamp(Math.round(b[0] * width), 0, width - 1)
  const y = clamp(Math.round(b[1] * height), 0, height - 1)
  return { x, y, w: clamp(Math.round((b[2] - b[0]) * width), 1, width - x), h: clamp(Math.round((b[3] - b[1]) * height), 1, height - y) }
}

/** 초 → m:ss.mmm (프레임 단위로 보이게) */
export function formatFrameTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${s.toFixed(3).padStart(6, '0')}`
}

/** 영상이 실제로 그려진 칸 (object-fit: contain의 여백 제외): 오버레이 기준 화면 좌표 + 배율 + 지금 영상의 원래 크기 */
export interface VideoView {
  left: number
  top: number
  scale: number
  vw: number
  vh: number
}

/**
 * 영상 위 오버레이(boxRef를 붙인 칸)에서 영상이 그려진 위치를 잰다. active일 때만 (오버레이를 그릴 때),
 * 영상(key)이 바뀌거나 크기가 바뀌면 다시
 */
export function useVideoView(videoRef: React.RefObject<HTMLVideoElement | null>, active: boolean, key: unknown) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<VideoView | null>(null)
  useLayoutEffect(() => {
    const video = videoRef.current
    const box = boxRef.current
    if (!video || !box) return
    const measure = () => {
      if (!video.videoWidth || !video.videoHeight) return setView(null)
      const v = video.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      const scale = Math.min(v.width / video.videoWidth, v.height / video.videoHeight)
      setView({
        left: v.left - b.left + (v.width - video.videoWidth * scale) / 2,
        top: v.top - b.top + (v.height - video.videoHeight * scale) / 2,
        scale,
        vw: video.videoWidth,
        vh: video.videoHeight,
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(video)
    observer.observe(box)
    video.addEventListener('loadedmetadata', measure)
    return () => {
      observer.disconnect()
      video.removeEventListener('loadedmetadata', measure)
    }
  }, [videoRef, key, active])
  return { boxRef, view }
}
