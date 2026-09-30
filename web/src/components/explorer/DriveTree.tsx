import { useEffect, useState } from 'react'
import { api, type FileEntry } from '../../api'
import { Icon } from './Icon'

interface Props {
  agentId: string
  currentPath: string
  onNavigate: (path: string) => void
  /** 노드 우클릭 (드라이브 루트는 isDrive=true) */
  onContextMenu?: (e: React.MouseEvent, entry: FileEntry, isDrive: boolean) => void
}

type Children = FileEntry[] | 'loading' | 'error'

const same = (a: string, b: string) => a.replace(/\\+$/, '').toLowerCase() === b.replace(/\\+$/, '').toLowerCase()

/** 윈도우 탐색기식 드라이브 트리 (폴더만, 펼칠 때 하위 폴더를 그때그때 불러온다) */
export function DriveTree({ agentId, currentPath, onNavigate, onContextMenu }: Props) {
  const [drives, setDrives] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [childrenByPath, setChildrenByPath] = useState<Record<string, Children>>({})

  useEffect(() => {
    let active = true
    api.listFiles(agentId, '').then(
      (result) => active && (result.error ? setError(result.error) : setDrives(result.entries)),
      (err) => active && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      active = false
    }
  }, [agentId])

  const loadChildren = (path: string) => {
    setChildrenByPath((prev) => ({ ...prev, [path]: 'loading' }))
    api.listFiles(agentId, path).then(
      (result) =>
        setChildrenByPath((prev) => ({
          ...prev,
          [path]: result.error ? 'error' : result.entries.filter((e) => e.isDirectory),
        })),
      () => setChildrenByPath((prev) => ({ ...prev, [path]: 'error' })),
    )
  }

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        if (!childrenByPath[path]) loadChildren(path)
      }
      return next
    })
  }

  const renderNode = (entry: FileEntry, depth: number) => {
    const open = expanded.has(entry.fullPath)
    const kids = childrenByPath[entry.fullPath]
    const isCurrent = same(entry.fullPath, currentPath)
    return (
      <li key={entry.fullPath}>
        <div
          className={`drive-node${isCurrent ? ' current' : ''}`}
          style={{ paddingLeft: 2 + depth * 10 }}
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, entry, depth === 0) : undefined}
        >
          <button type="button" className="tree-caret" onClick={() => toggle(entry.fullPath)} aria-label={open ? '접기' : '펼치기'}>
            {open ? '▾' : '▸'}
          </button>
          <button type="button" className="drive-name ellipsis fav-btn" title={entry.fullPath} onClick={() => onNavigate(entry.fullPath)}>
            <Icon name={depth === 0 ? 'drive' : 'folder'} size={14} /> {entry.name}
          </button>
        </div>
        {open && (
          <ul className="tree-children">
            {kids === 'loading' && <li className="drive-hint small muted">불러오는 중…</li>}
            {kids === 'error' && <li className="drive-hint small error">열 수 없음</li>}
            {Array.isArray(kids) && kids.length === 0 && <li className="drive-hint small muted">하위 폴더 없음</li>}
            {Array.isArray(kids) && kids.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <div className="pane-side-section">
      <div className="pane-side-title">드라이브</div>
      {error && <div className="drive-hint small error">{error}</div>}
      {!drives && !error && <div className="drive-hint small muted">불러오는 중…</div>}
      <ul className="drive-tree">{drives?.map((d) => renderNode(d, 0))}</ul>
    </div>
  )
}
