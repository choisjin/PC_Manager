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

const LIST_LIMIT = 1000

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
  const [search, setSearch] = useState('')
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of values) m.set(v, (m.get(v) ?? 0) + 1)
    // 지금 거르고 있는 값이 다른 열 때문에 빠졌어도 목록에는 남긴다
    for (const v of filter?.values ?? []) if (!m.has(v)) m.set(v, 0)
    return [...m.entries()].sort((a, b) => compareCells(a[0], b[0]))
  }, [values, filter])
  const [checked, setChecked] = useState<Set<string>>(() => new Set(filter?.values ?? counts.map(([v]) => v)))

  const q = search.trim().toLowerCase()
  const shown = q ? counts.filter(([v]) => label(v).toLowerCase().includes(q)) : counts
  const allShown = shown.every(([v]) => checked.has(v))

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
    for (const [v] of shown) {
      if (allShown) next.delete(v)
      else next.add(v)
    }
    return next
  })
  const apply = () => {
    // 검색 중이면 검색에 걸린 값 중 체크한 것만 (엑셀과 같음)
    const picked = (q ? shown : counts).map(([v]) => v).filter((v) => checked.has(v))
    onApply(!q && picked.length === counts.length ? null : { values: picked })
    onClose()
  }

  // 화면 오른쪽·아래로 넘치지 않게
  const left = Math.max(4, Math.min(x, window.innerWidth - 284))
  const top = Math.max(4, Math.min(y, window.innerHeight - 440))

  return (
    <div
      ref={ref}
      className="rv-colfilter panel"
      style={{ left, top }}
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
      <input autoFocus placeholder="검색" value={search} onChange={(e) => setSearch(e.target.value)} />
      <ul className="rv-colfilter-list">
        <li>
          <label>
            <input type="checkbox" checked={shown.length > 0 && allShown} onChange={toggleAll} />
            {q ? '(검색 결과 모두 선택)' : '(모두 선택)'}
          </label>
        </li>
        {shown.slice(0, LIST_LIMIT).map(([v, n]) => (
          <li key={v}>
            <label title={label(v)}>
              <input
                type="checkbox"
                checked={checked.has(v)}
                onChange={() => setChecked((prev) => {
                  const next = new Set(prev)
                  if (next.has(v)) next.delete(v)
                  else next.add(v)
                  return next
                })}
              />
              <span className="ellipsis">{label(v) || '(빈 값)'}</span>
              <span className="muted small">{n}</span>
            </label>
          </li>
        ))}
        {shown.length > LIST_LIMIT && <li className="muted small">… {shown.length - LIST_LIMIT}개 더 (검색으로 좁히세요)</li>}
      </ul>
      <div className="rv-setup-actions">
        <button type="button" onClick={onClose}>취소</button>
        <button type="button" className="primary" disabled={(q ? shown : counts).every(([v]) => !checked.has(v))} onClick={apply}>확인</button>
      </div>
    </div>
  )
}
