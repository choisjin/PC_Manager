import { useEffect, useState } from 'react'

/**
 * 지금 화면 맨 위에 그려지는 층의 요소: 전체 화면 요소 → 열린 모달 대화상자(마지막) → body.
 * 모달(showModal)과 전체 화면은 브라우저의 '최상위 층'이라 z-index로는 그 위에 올릴 수 없으므로,
 * 떠 있는 위젯(PiP)을 이 요소 안으로 옮겨 그려야 원격조작·전체 화면에서도 보인다.
 */
export function useTopLayer(): HTMLElement {
  const [layer, setLayer] = useState<HTMLElement>(() => findTopLayer())
  useEffect(() => {
    const update = () => setLayer((current) => {
      const next = findTopLayer()
      return next === current ? current : next
    })
    // 대화상자 열기/닫기(open 속성)·추가/제거, 전체 화면 전환을 지켜본다
    const observer = new MutationObserver(update)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })
    document.addEventListener('fullscreenchange', update)
    return () => {
      observer.disconnect()
      document.removeEventListener('fullscreenchange', update)
    }
  }, [])
  return layer
}

function findTopLayer(): HTMLElement {
  const fullscreen = document.fullscreenElement
  if (fullscreen instanceof HTMLElement) return fullscreen
  const modals = [...document.querySelectorAll('dialog[open]')].filter((d) => {
    try {
      return d.matches(':modal')
    } catch {
      return false
    }
  })
  const last = modals[modals.length - 1]
  return last instanceof HTMLElement ? last : document.body
}
