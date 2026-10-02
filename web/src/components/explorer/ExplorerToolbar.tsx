import { useEffect, useState } from 'react'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { buildCrumbs, type PaneController, type SortKey } from './paneController'

interface Props {
  controller: PaneController | null
}

const SORT_LABELS: Record<SortKey, string> = {
  name: '이름',
  modified: '수정한 날짜',
  type: '유형',
  size: '크기',
}

/** 현재 활성 창(pane)에 적용되는 상단 통합 툴바 (윈도우 11 탐색기 스타일) */
export function ExplorerToolbar({ controller }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  // 활성 창이 바뀌면 주소 편집 상태 초기화
  useEffect(() => {
    setEditing(false)
  }, [controller?.paneId, controller?.path])

  const c = controller
  const disabled = !c || !c.online
  // 압축 파일 안은 읽기 전용
  const readOnly = disabled || !!c?.inArchive
  const noSel = !c || c.selectionCount === 0
  const one = c?.selectionCount === 1

  const openMenuAt = (e: React.MouseEvent, items: MenuItem[]) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 2, items })
  }

  const sortMenu = (e: React.MouseEvent) => {
    if (!c) return
    const keys: SortKey[] = ['name', 'modified', 'type', 'size']
    openMenuAt(e, [
      ...keys.map((k) => ({
        label: `${c.sortKey === k ? '● ' : ''}${SORT_LABELS[k]}`,
        onClick: () => c.setSort(k),
      })),
      { separator: true },
      { label: `${c.sortAsc ? '● ' : ''}오름차순`, onClick: () => c.sortAsc || c.setSort(c.sortKey) },
      { label: `${!c.sortAsc ? '● ' : ''}내림차순`, onClick: () => !c.sortAsc || c.setSort(c.sortKey) },
    ])
  }

  const viewMenu = (e: React.MouseEvent) => {
    if (!c) return
    openMenuAt(e, [
      { label: `${c.view === 'icons' ? '● ' : ''}큰 아이콘`, onClick: () => c.setView('icons') },
      { label: `${c.view === 'details' ? '● ' : ''}자세히`, onClick: () => c.setView('details') },
      { separator: true },
      { label: `${c.showHidden ? '☑' : '☐'} 숨김 항목 보기`, onClick: () => c.toggleHidden() },
      { separator: true },
      { label: '표시할 열 (자세히 보기)', disabled: true, onClick: () => {} },
      { label: `${c.columns.modified ? '☑' : '☐'} 수정한 날짜`, onClick: () => c.toggleColumn('modified') },
      { label: `${c.columns.type ? '☑' : '☐'} 유형`, onClick: () => c.toggleColumn('type') },
      { label: `${c.columns.size ? '☑' : '☐'} 크기`, onClick: () => c.toggleColumn('size') },
    ])
  }

  const crumbs = c ? buildCrumbs(c.path) : []

  return (
    <div className={`win-toolbar${disabled ? ' toolbar-disabled' : ''}`}>
      {/* 1행: 이동 · 주소 · 검색 */}
      <div className="win-row win-addr-row">
        <div className="win-nav-btns">
          <button type="button" className="win-icon" title="뒤로" disabled={!c?.canBack} onClick={() => c?.back()}><Icon name="back" /></button>
          <button type="button" className="win-icon" title="앞으로" disabled={!c?.canForward} onClick={() => c?.forward()}><Icon name="forward" /></button>
          <button type="button" className="win-icon" title="위로" disabled={!c?.canUp} onClick={() => c?.up()}><Icon name="up" /></button>
          <button type="button" className="win-icon" title="새로 고침" disabled={!c} onClick={() => c?.refresh()}><Icon name="refresh" /></button>
        </div>

        {editing && c ? (
          <form
            className="win-addr-edit"
            onSubmit={(e) => {
              e.preventDefault()
              c.navigate(draft.trim())
              setEditing(false)
            }}
          >
            <input
              className="mono"
              autoFocus
              value={draft}
              placeholder="경로 입력 후 Enter (비우면 드라이브 목록)"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false)
              }}
            />
          </form>
        ) : (
          <div
            className="win-crumbs"
            title={c ? '클릭하면 경로를 직접 입력할 수 있어요' : undefined}
            onClick={() => {
              if (!c) return
              setDraft(c.path)
              setEditing(true)
            }}
          >
            <span className="win-crumb-pc"><Icon name="pc" size={18} /></span>
            {c ? (
              crumbs.map((crumb, i) => (
                <span key={crumb.target || 'pc'} className="win-crumb-seg">
                  {i > 0 && <span className="win-crumb-sep">›</span>}
                  <button
                    type="button"
                    className="win-crumb"
                    onClick={(e) => {
                      e.stopPropagation()
                      c.navigate(crumb.target)
                    }}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))
            ) : (
              <span className="muted small">창을 클릭해 선택하세요</span>
            )}
          </div>
        )}

        <div className="win-search">
          <Icon name="search" size={15} className="win-search-ico" />
          <input
            aria-label="현재 폴더 검색"
            placeholder={c ? `${crumbs[crumbs.length - 1]?.label ?? ''} 검색` : '검색'}
            disabled={!c}
            value={c?.search ?? ''}
            onChange={(e) => c?.setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* 2행: 명령 바 */}
      <div className="win-row win-cmd-row">
        <button type="button" className="win-cmd" disabled={readOnly || !c?.path} onClick={() => c?.newFolder()}>
          <Icon name="new-folder" /> 새로 만들기
        </button>
        <span className="win-sep" />
        <button type="button" className="win-cmd icon-only" title="잘라내기" disabled={readOnly || noSel} onClick={() => c?.cut()}><Icon name="cut" /></button>
        <button type="button" className="win-cmd icon-only" title="복사" disabled={disabled || noSel} onClick={() => c?.copy()}><Icon name="copy" /></button>
        <button type="button" className="win-cmd icon-only" title="붙여넣기" disabled={readOnly || !c?.canPaste} onClick={() => c?.paste()}><Icon name="paste" /></button>
        <button type="button" className="win-cmd icon-only" title="이름 바꾸기" disabled={readOnly || !one} onClick={() => c?.rename()}><Icon name="rename" /></button>
        <button type="button" className="win-cmd icon-only" title="가져오기(다운로드)" disabled={disabled || noSel} onClick={() => c?.fetchSelected()}><Icon name="download" /></button>
        <button type="button" className="win-cmd icon-only" title="삭제" disabled={readOnly || noSel} onClick={() => c?.remove()}><Icon name="delete" /></button>
        <span className="win-sep" />
        <button type="button" className="win-cmd" disabled={!c} onClick={sortMenu}><Icon name="sort" /> 정렬</button>
        <button type="button" className="win-cmd" disabled={!c} onClick={viewMenu}><Icon name={c?.view === 'icons' ? 'view-grid' : 'view-details'} /> 보기</button>
        <span className="win-spacer" />
        <button type="button" className="win-cmd icon-only" title="원격조작" disabled={disabled} onClick={() => c?.openRemote()}><Icon name="remote" /></button>
        <button type="button" className="win-cmd icon-only" title="터미널 열기" disabled={disabled} onClick={() => c?.openTerminal()}><Icon name="terminal" /></button>
        <button type="button" className="win-cmd icon-only" title="올리기(업로드)" disabled={readOnly || !c?.path} onClick={() => c?.upload()}><Icon name="upload" /></button>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
