import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { api, type OrgUser } from '../api'
import { UNGROUPED_FOLDER } from '../perms'
import type { FolderNode } from './explorer/pcGroups'
import { type FolderTree, subtreeIds } from './folderPermTree'

interface Props {
  user: OrgUser
  /** 지금 볼 수 있는 폴더 (null = 모든 폴더) */
  current: readonly string[] | null
  tree: FolderTree
  /** 로그인 세션 (관리자 API) */
  token: string
  onClose: () => void
}

/**
 * 인원 권한 › PC 폴더: 이 사람이 볼 수 있는 PC 목록 폴더를 고른다 (기본 모든 폴더).
 * 폴더를 고르면 아래 폴더도 함께 골라지고, 아래 폴더만 따로 빼거나 넣을 수도 있다
 */
export function FolderPermDialog({ user, current, tree, token, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const everything = useMemo(() => [...subtreeIds(tree.roots), UNGROUPED_FOLDER], [tree])
  const [all, setAll] = useState(current === null)
  // 고른 폴더만으로 바꾸면 처음에는 모두 골라 둔다 (그 뒤 뺄 폴더를 끈다)
  const [picked, setPicked] = useState<Set<string>>(() => new Set(current ?? everything))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  const setMany = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.setUserFolders(token, user.id, all ? null : [...picked])
      dialogRef.current?.close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const renderNode = (n: FolderNode, depth: number): ReactNode => {
    const on = picked.has(n.folder.id)
    const below = subtreeIds(n.children)
    const partly = !on && below.some((id) => picked.has(id))
    return (
      <Fragment key={n.folder.id}>
        <label className="fp-row" style={{ paddingLeft: 4 + depth * 16 }}>
          <input
            type="checkbox"
            checked={all || on}
            disabled={all}
            ref={(el) => {
              if (el) el.indeterminate = !all && partly
            }}
            onChange={() => setMany([n.folder.id, ...below], !on)}
          />
          <span aria-hidden="true">📂</span>
          <span className="ellipsis" translate="no">
            {n.folder.name}
          </span>
          <span className="fp-count">PC {n.agents.length}</span>
        </label>
        {n.children.map((c) => renderNode(c, depth + 1))}
      </Fragment>
    )
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog folder-perm-dialog"
      // 진행상황 PiP가 저장 버튼을 가리지 않게 (PiP는 이 창 아래에 그대로)
      data-no-pip
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current.close()
      }}
    >
      <div className="dialog-head">
        <h2>
          PC 폴더 권한 — <span translate="no">{user.name}</span>
        </h2>
        <button type="button" className="icon" aria-label="닫기" onClick={() => dialogRef.current?.close()}>
          ✕
        </button>
      </div>
      <div className="dialog-body">
        <div className="fp-mode" role="radiogroup" aria-label="볼 수 있는 폴더">
          <label>
            <input type="radio" name="fp-mode" checked={all} onChange={() => setAll(true)} />
            <span>모든 폴더</span>
            <span className="muted">(새로 만드는 폴더 포함)</span>
          </label>
          <label>
            <input type="radio" name="fp-mode" checked={!all} onChange={() => setAll(false)} />
            <span>고른 폴더만</span>
          </label>
          {!all && (
            <span className="fp-quick">
              <button type="button" className="small-btn" onClick={() => setPicked(new Set(everything))}>
                모두 고르기
              </button>
              <button type="button" className="small-btn" onClick={() => setPicked(new Set())}>
                모두 해제
              </button>
            </span>
          )}
        </div>
        <div className={`fp-tree${all ? ' off' : ''}`}>
          {tree.roots.map((n) => renderNode(n, 0))}
          <label className="fp-row">
            <input
              type="checkbox"
              checked={all || picked.has(UNGROUPED_FOLDER)}
              disabled={all}
              onChange={() => setMany([UNGROUPED_FOLDER], !picked.has(UNGROUPED_FOLDER))}
            />
            <span className="muted">미분류 PC (폴더에 넣지 않은 PC)</span>
            <span className="fp-count">PC {tree.ungrouped.length}</span>
          </label>
        </div>
        <p className="muted small">
          고른 폴더의 PC만 보입니다 (PC Manager · Remote · Result · State). 고르지 않은 상위 폴더는 이름만 보이고 그 안의 PC는 보이지 않습니다. 고른
          폴더 아래에 새로 만든 폴더와 그 사람이 직접 만든 폴더는 저절로 들어갑니다.
        </p>
        {error && <p className="warning-box">{error}</p>}
      </div>
      <div className="dialog-actions">
        <span className="muted small">취소하려면 바깥을 클릭하거나 ✕</span>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? '저장 중…' : '저장'}
        </button>
      </div>
    </dialog>
  )
}
