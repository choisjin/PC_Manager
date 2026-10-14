import { useEffect, useMemo, useRef, useState } from 'react'
import { compareCells } from './resultCsv'

/** 열 하나의 거르기: 값 목록(null = 전체) */
export interface ColFilter {
  values: string[] | null
}
export type ColFilters = Record<number, ColFilter>
export interface ColSort {
  col: number
  asc: boolean
}

// 값 목록: 값이 수천 개여도 다 보여 주되 보이는 줄만 그린다
interface Group {
  /** 목록에 보이는 글 */
  text: string
  /** 그 글로 보이는 원래 값들 */
  values: string[]
  count: number
}

const ITEM_HEIGHT = 20
const LIST_MAX_HEIGHT = 260
const MIN_WIDTH = 280

/** 엑셀 자동 필터처럼: 정렬 · 검색 · 값 체크 목록 */
export function ColumnFilterMenu({ x, y, title, values, label, filter, sort, onApply, onSort, onClose }: {
  x: number
  y: number
  title: string
  /** 다른 열 거르기를 적용한 행들의 이 열 값 (중복 포함) */
  values: string[]
  label: (v: string) => string
  filter: ColFilter | undefined
  sort: 'asc' | 'desc' | null
  onApply: (f: ColFilter | null) => void
  onSort: (asc: boolean) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const [scroll, setScroll] = useState(0)
  // label은 부르는 쪽에서 매번 새로 만들어지므로(영상 재생 중 계속) 값 목록이 바뀔 때만 다시 묶는다
  const labelRef = useRef(label)
  labelRef.current = label
  // 보이는 글이 같은 값은 한 줄로 묶는다 (예: 앞 50자만 보이는 HTTP 로그). 거르기는 원래 값으로
  const groups = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of values) m.set(v, (m.get(v) ?? 0) + 1)
    // 지금 거르고 있는 값이 다른 열 때문에 빠졌어도 목록에는 남긴다
    for (const v of filter?.values ?? []) if (!m.has(v)) m.set(v, 0)
    const byText = new Map<string, Group>()
    for (const [v, n] of [...m.entries()].sort((a, b) => compareCells(a[0], b[0]))) {
      const text = labelRef.current(v) || '(빈 값)'
      const g = byText.get(text)
      if (g) {
        g.values.push(v)
        g.count += n
      } else byText.set(text, { text, values: [v], count: n })
    }
    return [...byText.values()]
  }, [values, filter])
  const valueCount = useMemo(() => groups.reduce((sum, g) => sum + g.values.length, 0), [groups])
  const [checked, setChecked] = useState<Set<string>>(() => new Set(filter?.values ?? groups.flatMap((g) => g.values)))
  const isOn = (g: Group) => g.values.every((v) => checked.has(v))

  const q = search.trim().toLowerCase()
  // 줄여 보이는 값도 원래 값 전체에서 찾는다
  const shown = q ? groups.filter((g) => g.text.toLowerCase().includes(q) || g.values.some((v) => v.toLowerCase().includes(q))) : groups
  const allShown = shown.every(isOn)

  // 가장 긴 값이 줄임 없이 보이도록 창을 넓힌다 (화면보다 길면 목록을 가로로 스크롤)
  const textWidth = useMemo(() => {
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return 0
    context.font = `12px ${getComputedStyle(document.body).fontFamily}`
    let widest = 0
    for (const g of groups) widest = Math.max(widest, context.measureText(g.text).width + context.measureText(String(g.count)).width)
    return Math.ceil(widest)
  }, [groups])
  // 체크 상자 · 칸 사이 · 목록 여백 · 세로 스크롤 막대
  const width = Math.min(window.innerWidth - 8, Math.max(MIN_WIDTH, textWidth + 64))
  const rowWidth = textWidth + 40

  // 0번 줄은 (모두 선택)
  const total = shown.length + 1
  const listHeight = Math.min(LIST_MAX_HEIGHT, total * ITEM_HEIGHT + 8)
  const first = Math.max(0, Math.floor(scroll / ITEM_HEIGHT) - 5)
  const last = Math.min(total, Math.ceil((scroll + listHeight) / ITEM_HEIGHT) + 5)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element
      // 머리글 누름은 머리글이 처리 (같은 머리글 = 닫기, 다른 머리글 = 바꿔 열기)
      if (ref.current && !ref.current.contains(target) && !target.closest?.('.rv-colhead')) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const toggleAll = () => setChecked((prev) => {
    const next = new Set(prev)
    for (const g of shown) {
      for (const v of g.values) {
        if (allShown) next.delete(v)
        else next.add(v)
      }
    }
    return next
  })
  const apply = () => {
    // 검색 중이면 검색에 걸린 값 중 체크한 것만 (엑셀과 같음)
    const picked = (q ? shown : groups).flatMap((g) => g.values).filter((v) => checked.has(v))
    onApply(!q && picked.length === valueCount ? null : { values: picked })
    onClose()
  }

  // 화면 오른쪽·아래로 넘치지 않게
  const left = Math.max(4, Math.min(x, window.innerWidth - width - 4))
  const top = Math.max(4, Math.min(y, window.innerHeight - 440))

  return (
    <div
      ref={ref}
      className="rv-colfilter panel"
      style={{ left, top, width }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        } else if (e.key === 'Enter') apply()
      }}
    >
      <div className="rv-colfilter-title small muted ellipsis" title={title}>{title}</div>
      <button type="button" className={`rv-colfilter-item${sort === 'asc' ? ' active' : ''}`} onClick={() => { onSort(true); onClose() }}>↑ 오름차순 정렬</button>
      <button type="button" className={`rv-colfilter-item${sort === 'desc' ? ' active' : ''}`} onClick={() => { onSort(false); onClose() }}>↓ 내림차순 정렬</button>
      <button type="button" className="rv-colfilter-item" disabled={!filter} onClick={() => { onApply(null); onClose() }}>✕ "{title}" 필터 지우기</button>
      <input
        autoFocus
        placeholder="검색"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value)
          // 검색이 바뀌면 목록 맨 위로
          if (listRef.current) listRef.current.scrollTop = 0
          setScroll(0)
        }}
      />
      <div
        className="rv-colfilter-list"
        ref={listRef}
        style={{ height: listHeight }}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
      >
        <div style={{ position: 'relative', height: total * ITEM_HEIGHT, minWidth: rowWidth }}>
          {Array.from({ length: last - first }, (_, k) => {
            const i = first + k
            const style = { position: 'absolute', top: i * ITEM_HEIGHT, left: 0, right: 0, height: ITEM_HEIGHT } as const
            if (i === 0) {
              return (
                <label key="(all)" style={style}>
                  <input type="checkbox" checked={shown.length > 0 && allShown} onChange={toggleAll} />
                  <span className="rv-colfilter-text">{q ? '(검색 결과 모두 선택)' : '(모두 선택)'}</span>
                </label>
              )
            }
            const g = shown[i - 1]
            const on = isOn(g)
            return (
              <label key={g.text} style={style} title={g.values.length === 1 ? g.values[0] : `${g.text} (값 ${g.values.length}개)`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setChecked((prev) => {
                    const next = new Set(prev)
                    for (const v of g.values) {
                      if (on) next.delete(v)
                      else next.add(v)
                    }
                    return next
                  })}
                />
                <span className="rv-colfilter-text">{g.text}</span>
                <span className="muted small">{g.count}</span>
              </label>
            )
          })}
        </div>
      </div>
      <div className="rv-setup-actions">
        <button type="button" onClick={onClose}>취소</button>
        <button type="button" className="primary" disabled={(q ? shown : groups).every((g) => g.values.every((v) => !checked.has(v)))} onClick={apply}>확인</button>
      </div>
    </div>
  )
}
