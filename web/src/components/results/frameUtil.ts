import { useLayoutEffect, useRef, useState } from 'react'
import type { Rect } from './imageSearchState'

// 결과 확인의 영상 위 표시·영역 고르기 창이 함께 쓰는 도구 (이미지 찾기 · 영상 분석)

/** 비율 좌표의 네 꼭짓점 [x, y]×4 (왼쪽 위 · 오른쪽 위 · 오른쪽 아래 · 왼쪽 아래): 비스듬히 찍힌 화면 */
export type Quad = [number, number, number, number, number, number, number, number]
/** 꼭짓점 하나 [x, y] */
export type Point = [number, number]

/** 직사각형([x0, y0, x1, y1]) 또는 꼭짓점 넷(값 8개) → 꼭짓점 넷 */
export function cornersOf(r: readonly number[]): Point[] {
  if (r.length >= 8) return [[r[0], r[1]], [r[2], r[3]], [r[4], r[5]], [r[6], r[7]]]
  const [x0, y0, x1, y1] = r
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

/** 모퉁이마다 꺾는 방향이 같다 (볼록하고 꼭짓점 차례가 꼬이지 않음) */
export function convexQuad(p: Point[]): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [p[i], p[(i + 1) % 4], p[(i + 2) % 4]]
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (Math.abs(cross) < 1e-9) return false
    if (!sign) sign = Math.sign(cross)
    else if (Math.sign(cross) !== sign) return false
  }
  return true
}

/** outer(볼록)가 inner의 네 꼭짓점을 모두 감싼다 (경계 포함) */
export function quadContains(outer: Point[], inner: Point[]): boolean {
  return inner.every(([x, y]) => {
    let sign = 0
    for (let i = 0; i < 4; i++) {
      const [a, b] = [outer[i], outer[(i + 1) % 4]]
      const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
      if (Math.abs(cross) < 1e-7) continue
      if (!sign) sign = Math.sign(cross)
      else if (Math.sign(cross) !== sign) return false
    }
    return true
  })
}

/** 정사각형 [0,1]² → 사각형 (Heckbert): (u, v)가 꼭짓점 차례로 (0,0) (1,0) (1,1) (0,1)에 간다 — 반듯하게 편 미리 보기 */
export function squareToQuad(p: Point[]): (u: number, v: number) => Point {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p
  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const dx3 = x0 - x1 + x2 - x3
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const dy3 = y0 - y1 + y2 - y3
  let g = 0
  let h = 0
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1
    g = (dx3 * dy2 - dx2 * dy3) / den
    h = (dx1 * dy3 - dx3 * dy1) / den
  }
  const [a, b, c] = [x1 - x0 + g * x1, x3 - x0 + h * x3, x0]
  const [d, e, f] = [y1 - y0 + g * y1, y3 - y0 + h * y3, y0]
  return (u, v) => {
    const w = g * u + h * v + 1
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w]
  }
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 사각형을 배율대로 (프레임 안으로) */
export function scaleRect(r: Rect, sx: number, sy: number, frame: { width: number; height: number }): Rect {
  const x = clamp(Math.round(r.x * sx), 0, frame.width - 1)
  const y = clamp(Math.round(r.y * sy), 0, frame.height - 1)
  return { x, y, w: clamp(Math.round(r.w * sx), 1, frame.width - x), h: clamp(Math.round(r.h * sy), 1, frame.height - y) }
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
