import { useEffect, useMemo, useState } from 'react'
import { api, type FileEntry } from '../../api'
import { isVideoFile } from '../../fileTypes'
import { formatBytes } from '../../format'
import { DriveTree } from '../explorer/DriveTree'
import { Icon, ShellIcon } from '../explorer/Icon'
import { buildCrumbs, fileTypeLabel, type SortKey, sortEntries } from '../explorer/paneController'
import { type ClipItem, FILES_MIME, type FilesDragPayload } from '../explorer/pcGroups'

interface Props {
  agentId: string
  /** 아이콘을 받아 올 내 PC 에이전트 (탐색기와 같은 아이콘) */
  selfAgentId: string | null
  startPath: string
  /** 이 PC의 즐겨찾기 (탐색기와 같은 목록) */
  favorites: string[]
  /** Result로 쓸 수 있는 파일 */
  isResult: (name: string) => boolean
  /** 폴더를 넣을 칸 (RFW: 이미지 · ATS: 원본·결과 이미지) */
  folderSlots: { slot: FolderSlot; label: string }[]
  onPut: (slot: PutSlot, item: ClipItem) => void
}

export type FolderSlot = 'image' | 'ref'
export type PutSlot = 'result' | 'video' | FolderSlot

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
const favName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const pad2 = (n: number) => String(n).padStart(2, '0')
const formatFileDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** 결과 확인용 탐색기: 탐색기와 같은 주소 표시줄·즐겨찾기·드라이브 트리 + 자세히 목록 (고른 항목을 Result·영상·이미지 칸으로) */
export function ResultBrowser({ agentId, selfAgentId, startPath, favorites, isResult, folderSlots, onPut }: Props) {
  const [history, setHistory] = useState<{ stack: string[]; idx: number }>({ stack: [startPath], idx: 0 })
  const path = history.stack[history.idx] ?? ''
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    api.listFiles(agentId, path).then(
      (l) => {
        if (!alive) return
        setLoading(false)
        if (l.error) return setError(l.error)
        setEntries(l.entries)
        setParent(l.parentPath)
        setSelected(null)
        // 방문 기록의 현재 항목을 정규화된 경로로
        if (l.path !== path) setHistory((h) => {
          const stack = h.stack.slice()
          stack[h.idx] = l.path
          return { ...h, stack }
        })
      },
      (err) => {
        if (!alive) return
        setLoading(false)
        setError(toMessage(err))
      },
    )
    return () => {
      alive = false
    }
  }, [agentId, path, reloadKey])

  const navigate = (target: string) => {
    setSearch('')
    setEditing(false)
    setHistory((h) => {
      const stack = h.stack.slice(0, h.idx + 1)
      if (stack[stack.length - 1] !== target) stack.push(target)
      return { stack, idx: stack.length - 1 }
    })
  }
  const go = (step: 1 | -1) => {
    setSearch('')
    setHistory((h) => ({ ...h, idx: Math.max(0, Math.min(h.stack.length - 1, h.idx + step)) }))
  }

  const displayed = useMemo(() => {
    const visible = entries.filter((e) => !e.hidden)
    const q = search.trim().toLowerCase()
    return sortEntries(q ? visible.filter((e) => e.name.toLowerCase().includes(q)) : visible, sortKey, sortAsc)
  }, [entries, search, sortKey, sortAsc])

  const applySort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((a) => !a)
    else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  const crumbs = buildCrumbs(path)
  const toItem = (e: FileEntry): ClipItem => ({ path: e.fullPath, name: e.name, isDir: e.isDirectory })

  // 더블클릭: 폴더는 열고, Result·영상 파일은 그 칸에 넣는다
  const open = (e: FileEntry) => {
    if (e.isDirectory) navigate(e.fullPath)
    else if (isResult(e.name)) onPut('result', toItem(e))
    else if (isVideoFile(e.name)) onPut('video', toItem(e))
  }

  return (
    <section className="rv-browser panel">
      <div className="win-row win-addr-row rv-browser-bar">
        <div className="win-nav-btns">
          <button type="button" className="win-icon" title="뒤로" disabled={history.idx <= 0} onClick={() => go(-1)}><Icon name="back" /></button>
          <button type="button" className="win-icon" title="앞으로" disabled={history.idx >= history.stack.length - 1} onClick={() => go(1)}><Icon name="forward" /></button>
          <button type="button" className="win-icon" title="위로" disabled={parent === null} onClick={() => parent !== null && navigate(parent)}><Icon name="up" /></button>
          <button type="button" className="win-icon" title="새로 고침" onClick={() => setReloadKey((k) => k + 1)}><Icon name="refresh" /></button>
        </div>
        {editing ? (
          <form
            className="win-addr-edit"
            onSubmit={(e) => {
              e.preventDefault()
              navigate(draft.trim())
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
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setEditing(false)
                }
              }}
            />
          </form>
        ) : (
          <div
            className="win-crumbs"
            title="클릭하면 경로를 직접 입력할 수 있어요"
            onClick={() => {
              setDraft(path)
              setEditing(true)
            }}
          >
            <span className="win-crumb-pc"><Icon name="pc" size={18} /></span>
            {crumbs.map((crumb, i) => (
              <span key={crumb.target || 'pc'} className="win-crumb-seg">
                {i > 0 && <span className="win-crumb-sep">›</span>}
                <button
                  type="button"
                  className="win-crumb"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(crumb.target)
                  }}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="win-search rv-browser-search">
          <Icon name="search" size={15} className="win-search-ico" />
          <input
            aria-label="현재 폴더 검색"
            placeholder={`${crumbs[crumbs.length - 1]?.label ?? ''} 검색`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {folderSlots.map(({ slot, label }) => (
          <button key={slot} type="button" disabled={!path} onClick={() => onPut(slot, { path, name: favName(path), isDir: true })} title={`지금 폴더를 ${label} 폴더로`}>
            이 폴더 = {label}
          </button>
        ))}
      </div>

      <div className="pane-body rv-browser-body">
        <div className="pane-side rv-browser-side">
          <div className="pane-side-section">
            <div className="pane-side-title">즐겨찾기</div>
            {favorites.length === 0 && <div className="drive-hint small muted">탐색기에서 폴더 우클릭 → 즐겨찾기에 추가</div>}
            <ul className="fav-list">
              {favorites.map((fp) => (
                <li key={fp} className={`fav-item${samePath(fp, path) ? ' current' : ''}`}>
                  <button type="button" className="drive-name ellipsis fav-btn" title={fp} onClick={() => navigate(fp)}>
                    <Icon name="star" size={13} /> {favName(fp)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <DriveTree agentId={agentId} currentPath={path} onNavigate={navigate} />
        </div>

        <div className="table-wrap">
          {error && <p className="error small rv-browser-msg">{error}</p>}
          {!error && displayed.length === 0 ? (
            <div className="pane-empty placeholder">{search ? '검색 결과가 없습니다' : loading ? '불러오는 중…' : '빈 폴더입니다'}</div>
          ) : !error && (
            <table className="noselect details-table rv-browser-table">
              <colgroup>
                <col />
                <col style={{ width: 130 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 70 }} />
              </colgroup>
              <thead>
                <tr>
                  {([['name', '이름'], ['modified', '수정한 날짜'], ['type', '유형'], ['size', '크기']] as const).map(([key, label]) => (
                    <th key={key} className="sortable" onClick={() => applySort(key)}>
                      {label}{sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {displayed.map((entry) => {
                  const item = toItem(entry)
                  return (
                    <tr
                      key={entry.fullPath}
                      className={`${entry.isDirectory ? 'dir' : isVideoFile(entry.name) ? 'file video' : 'file'}${selected === entry.fullPath ? ' selected' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(FILES_MIME, JSON.stringify({ agentId, items: [item] } satisfies FilesDragPayload))
                        e.dataTransfer.setData('text/plain', entry.fullPath)
                      }}
                      onClick={() => setSelected(entry.fullPath)}
                      onDoubleClick={() => open(entry)}
                      title={entry.isDirectory ? '더블클릭으로 열기 · 오른쪽 칸으로 끌어다 놓기' : '더블클릭 또는 오른쪽 칸으로 끌어다 놓기'}
                    >
                      <td className="ellipsis">
                        <ShellIcon name={entry.name} folder={entry.isDirectory} agentId={selfAgentId} className="file-icon" />
                        {entry.name}
                      </td>
                      <td className="col-date">{entry.modifiedAt ? formatFileDate(entry.modifiedAt) : ''}</td>
                      <td className="ellipsis">{fileTypeLabel(entry)}</td>
                      <td className="col-size">{entry.isDirectory ? '' : formatBytes(entry.size)}</td>
                      <td className="rv-browser-acts">
                        {!entry.isDirectory && isResult(entry.name) && <button type="button" onClick={() => onPut('result', item)}>Result</button>}
                        {!entry.isDirectory && isVideoFile(entry.name) && <button type="button" onClick={() => onPut('video', item)}>영상</button>}
                        {entry.isDirectory && folderSlots.map(({ slot, label }) => (
                          <button key={slot} type="button" onClick={() => onPut(slot, item)}>{label}</button>
                        ))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  )
}
