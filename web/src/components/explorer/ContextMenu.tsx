import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label?: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  /** 구분선 */
  separator?: boolean
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** Windows 탐색기 스타일의 우클릭 메뉴 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // 화면 밖으로 나가지 않게 위치 보정
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const nx = x + rect.width > window.innerWidth ? Math.max(4, window.innerWidth - rect.width - 4) : x
    const ny = y + rect.height > window.innerHeight ? Math.max(4, window.innerHeight - rect.height - 4) : y
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // 다음 틱부터 바깥 클릭 감지 (이 메뉴를 연 클릭이 즉시 닫지 않도록)
    const id = setTimeout(() => {
      window.addEventListener('click', close)
      window.addEventListener('contextmenu', close)
      window.addEventListener('resize', close)
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(id)
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-sep" />
        ) : (
          <button
            key={i}
            type="button"
            className={`context-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onClick?.()
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}
