import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label?: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  /** 구분선 */
  separator?: boolean
  /** 하위 메뉴 (마우스를 올리면 옆에 펼친다) */
  children?: MenuItem[]
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
  const [openSub, setOpenSub] = useState<number | null>(null)
  // 오른쪽 공간이 모자라면 하위 메뉴를 왼쪽으로
  const [subLeft, setSubLeft] = useState(false)

  // 화면 밖으로 나가지 않게 위치 보정
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const nx = x + rect.width > window.innerWidth ? Math.max(4, window.innerWidth - rect.width - 4) : x
    const ny = y + rect.height > window.innerHeight ? Math.max(4, window.innerHeight - rect.height - 4) : y
    setPos({ x: nx, y: ny })
    setSubLeft(nx + rect.width * 2 + 8 > window.innerWidth)
  }, [x, y])

  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // 메뉴 밖을 누르면 닫는다. 캡처 단계에서 받아 다른 요소가 클릭 전파를 막아도(표·트리·버튼 등) 닫히게
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    // 다음 틱부터 바깥 클릭 감지 (이 메뉴를 연 클릭이 즉시 닫지 않도록)
    const id = setTimeout(() => {
      window.addEventListener('pointerdown', onDown, true)
      window.addEventListener('contextmenu', close)
      window.addEventListener('resize', close)
      window.addEventListener('blur', close)
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(id)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const renderItem = (item: MenuItem, i: number) =>
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
    )

  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
      {items.map((item, i) =>
        item.children ? (
          <div
            key={i}
            className="context-sub"
            onMouseEnter={() => !item.disabled && setOpenSub(i)}
            onMouseLeave={() => setOpenSub((v) => (v === i ? null : v))}
          >
            <button
              type="button"
              className={`context-item context-sub-head${openSub === i ? ' open' : ''}`}
              disabled={item.disabled}
              onClick={() => setOpenSub(i)}
            >
              <span>{item.label}</span>
              <span className="context-sub-arrow">▸</span>
            </button>
            {openSub === i && (
              <div className={`context-menu context-submenu${subLeft ? ' left' : ''}`}>{item.children.map(renderItem)}</div>
            )}
          </div>
        ) : (
          renderItem(item, i)
        ),
      )}
    </div>
  )
}
