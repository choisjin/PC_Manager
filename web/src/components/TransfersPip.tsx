import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTopLayer } from '../useTopLayer'
import { HubBadges, HubPanel } from './SideHub'
import { HUB_TABS, type HubTab, type SideHub, useHubReveal, useReportChatShown, useSidebarCovered } from './sideHubState'

interface Props {
  /** 채팅·메모·진행상황 (App의 useSideHubState) */
  hub: SideHub
  /**
   * 사이드바가 있는 화면(PC Manager·Result): 사이드바 탭으로 보이므로 원격조작 창·전체 화면·결과 확인 전체 화면처럼
   * 사이드바를 가리는 것이 열려 있을 때만 그 위에 띄운다
   */
  overlayOnly?: boolean
}

const SIZE_KEY = 'pcm.pip.size2'
const MIN_W = 380
const MIN_H = 220
// 기본 크기: 왼쪽 방 목록 + 오른쪽 대화가 함께 보이게
const DEFAULT_SIZE = { w: 560, h: 420 }

function loadSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    return raw ? (JSON.parse(raw) as { w: number; h: number }) : DEFAULT_SIZE
  } catch {
    return DEFAULT_SIZE
  }
}

const TAB_KEY = 'pcm.pip.tab'

// 위치: 왼쪽(x)과 화면 아래에서 위젯 아래 모서리까지의 거리(b).
// 아래 모서리를 고정해 펼치면 위로 늘어나고 접으면 아래로 줄어든다
const POS_KEY = 'pcm.pip.pos2'
const COLLAPSED_KEY = 'pcm.pip.collapsed'

type PipPos = { x: number; b: number }

const clampPos = (p: PipPos): PipPos => ({
  x: Math.max(4, Math.min(window.innerWidth - 60, p.x)),
  b: Math.max(4, Math.min(window.innerHeight - 40, p.b)),
})

function loadPos(): PipPos {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw) return clampPos(JSON.parse(raw) as PipPos)
  } catch {
    // 무시
  }
  return { x: Math.max(12, window.innerWidth - 320), b: 12 }
}

function savePos(p: PipPos) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p))
  } catch {
    // 무시
  }
}

/** 채팅·메모·진행상황을 띄우는 떠 있는 위젯 (드래그 이동 + 펴고 접기). 내용·알림은 SideHub */
export function TransfersPip({ hub, overlayOnly = false }: Props) {
  const [pos, setPos] = useState(loadPos)
  // 위젯 크기 (위쪽 오른쪽 모서리를 끌어 조절)
  const [size, setSize] = useState<{ w: number; h: number }>(loadSize)
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const el = (e.currentTarget as HTMLElement).parentElement as HTMLElement
    const startX = e.clientX
    const startY = e.clientY
    const startW = el.offsetWidth
    const startH = el.offsetHeight
    const startPos = pos
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_W, Math.min(window.innerWidth - 8, startW + ev.clientX - startX))
      // 위로 끌면 커진다 (아래 모서리 고정). 화면 위를 넘지 않게
      const h = Math.max(MIN_H, Math.min(window.innerHeight - startPos.b - 8, startH - (ev.clientY - startY)))
      setSize({ w, h })
      // 오른쪽 화면 끝에 붙어 있으면 넓히는 만큼 왼쪽으로 밀어 준다
      setPos({ x: Math.min(startPos.x, Math.max(4, window.innerWidth - 4 - w)), b: startPos.b })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setSize((s) => {
        try {
          localStorage.setItem(SIZE_KEY, JSON.stringify(s))
        } catch {
          // 무시
        }
        return s
      })
      setPos((p) => {
        savePos(p)
        return p
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const HEAD_H = 30
  const bodyStyle = { height: size.h - HEAD_H, maxHeight: 'none' as const }
  const [tab, setTab] = useState<HubTab>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY)
      return saved === 'chat' || saved === 'notes' ? saved : 'transfers'
    } catch {
      return 'transfers'
    }
  })
  const switchTab = (next: HubTab) => {
    setTab(next)
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch {
      // 무시
    }
  }
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })

  // 원격조작 창·전체 화면처럼 브라우저 최상위 층이 열려 있으면 그 안에 그려야 위에 보인다
  const layer = useTopLayer()
  // 사이드바가 있는 화면에서 사이드바를 가리는 것이 없으면 띄우지 않는다 (사이드바 탭이 보여 준다)
  const covered = useSidebarCovered()
  const hidden = overlayOnly && !covered

  // 알림을 누름·결과 확인을 불러옴·분석이 시작하거나 끝남: 그 탭을 펼쳐 보여 준다
  useHubReveal(hub, (r) => {
    if (hidden) return
    switchTab(r.tab)
    setCollapsed(false)
  })
  useReportChatShown(hub, 'pip', !hidden && tab === 'chat' && !collapsed)

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, v ? '0' : '1')
      } catch {
        // 무시
      }
      return !v
    })
  }

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const base = pos
    const at = (ev: MouseEvent) => clampPos({ x: base.x + ev.clientX - startX, b: base.b - (ev.clientY - startY) })
    const onMove = (ev: MouseEvent) => setPos(at(ev))
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      savePos(at(ev))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 펼치거나 크기·내용이 바뀌어 화면 밖으로 넘치면 전체가 보이게 위치를 당긴다 (창 크기 변경 포함)
  const rootRef = useRef<HTMLDivElement>(null)
  const fitIntoView = () => {
    const el = rootRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // 높이 제한(maxHeight)에 눌리기 전의 원래 높이: 화면에 그려지기 전에 잠깐 제한을 풀고 잰다
    const cap = el.style.maxHeight
    el.style.maxHeight = 'none'
    const needed = el.offsetHeight
    el.style.maxHeight = cap
    setPos((p) => {
      let { x, b } = p
      if (p.b + needed > window.innerHeight - 8) b = Math.max(4, window.innerHeight - 8 - needed)
      if (rect.right > window.innerWidth - 4) x = Math.max(4, x - (rect.right - (window.innerWidth - 4)))
      if (b === p.b && x === p.x) return p
      const next = clampPos({ x, b })
      savePos(next)
      return next
    })
  }
  useLayoutEffect(fitIntoView, [collapsed, tab, size, layer, hidden])
  useEffect(() => {
    window.addEventListener('resize', fitIntoView)
    return () => window.removeEventListener('resize', fitIntoView)
  }, [])

  if (hidden) return null
  return createPortal(
    <div
      ref={rootRef}
      className={`pip${collapsed ? ' collapsed' : ''}`}
      style={{ left: pos.x, bottom: pos.b, maxHeight: `calc(100vh - ${pos.b + 8}px)`, ...(!collapsed ? { width: size.w } : {}) }}
    >
      {!collapsed && <div className="pip-resize" title="드래그해서 크기 조절" onMouseDown={startResize} />}
      <div
        className="pip-head"
        onMouseDown={startDrag}
        onDoubleClick={(e) => {
          // 탭·버튼 더블클릭은 제외
          if ((e.target as HTMLElement).closest('button')) return
          toggleCollapsed()
        }}
        title="끌어서 이동 · 더블클릭으로 펴고 접기"
      >
        <span className="pip-title">
          <span className="pip-grip" aria-hidden="true">⠿</span>
          <span className="pip-tabs" role="tablist" onMouseDown={(e) => e.stopPropagation()}>
            {HUB_TABS.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => switchTab(k)}>
                {label}
                <HubBadges hub={hub} tab={k} />
              </button>
            ))}
          </span>
        </span>
        <button type="button" className="pip-toggle" title={collapsed ? '펼치기 (위로)' : '접기'} onMouseDown={(e) => e.stopPropagation()} onClick={toggleCollapsed}>
          {collapsed ? '▴' : '▾'}
        </button>
      </div>

      {!collapsed && (
        <div className={`pip-body${tab === 'transfers' ? '' : ' pip-chat'}`} style={bodyStyle}>
          <HubPanel hub={hub} tab={tab} shown={!collapsed} />
        </div>
      )}
    </div>,
    layer,
  )
}
