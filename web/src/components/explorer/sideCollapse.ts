import { useState } from 'react'

// 사이드바 접기 (PC Manager·Result 화면이 함께 기억)
const COLLAPSE_KEY = 'pcm.explorer.collapsed'
export function useSideCollapse(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? 'false') === true
    } catch {
      return false
    }
  })
  const toggle = () => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(!v))
      } catch {
        // 기억만 못 한다
      }
      return !v
    })
  }
  return [collapsed, toggle]
}
