import { useEffect, useRef, useState } from 'react'
import type { Org } from '../api'
import type { OrgActions } from '../useDashboard'

interface Props {
  org: Org
  actions: OrgActions
  onClose: () => void
}

/** 프로젝트·사용자 관리 + 프로젝트별 사용자 할당 */
export function SettingsModal({ org, actions, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [projectName, setProjectName] = useState('')
  const [userName, setUserName] = useState('')
  const [selectedProject, setSelectedProject] = useState<string | null>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  const projectUsers = selectedProject ? (org.projectUsers[selectedProject] ?? []) : []

  const toggleUser = (userId: string) => {
    if (!selectedProject) return
    const next = projectUsers.includes(userId)
      ? projectUsers.filter((id) => id !== userId)
      : [...projectUsers, userId]
    void actions.setProjectUsers(selectedProject, next)
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog settings-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current.close()
      }}
    >
      <div className="dialog-head">
        <h2>프로젝트 · 사용자 관리</h2>
        <button type="button" className="icon" aria-label="닫기" onClick={() => dialogRef.current?.close()}>✕</button>
      </div>
      <div className="dialog-body settings-body">
        <div className="settings-col">
          <div className="pane-side-title">프로젝트</div>
          <form
            className="settings-add"
            onSubmit={(e) => {
              e.preventDefault()
              if (projectName.trim()) {
                void actions.createProject(projectName.trim())
                setProjectName('')
              }
            }}
          >
            <input placeholder="새 프로젝트 이름" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
            <button type="submit" className="small-btn">추가</button>
          </form>
          <ul className="settings-list">
            {org.projects.length === 0 && <li className="placeholder small">프로젝트 없음</li>}
            {org.projects.map((p) => (
              <li key={p.id} className={`settings-item${selectedProject === p.id ? ' active' : ''}`}>
                <button type="button" className="settings-item-name ellipsis" onClick={() => setSelectedProject(p.id)}>
                  {p.name}
                </button>
                <button
                  type="button"
                  className="icon-mini"
                  title="이름 바꾸기"
                  onClick={() => {
                    const name = window.prompt('프로젝트 이름', p.name)
                    if (name && name.trim() && name !== p.name) void actions.renameProject(p.id, name.trim())
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="icon-mini"
                  title="삭제"
                  onClick={() => {
                    if (window.confirm(`'${p.name}' 프로젝트를 삭제할까요?`)) {
                      if (selectedProject === p.id) setSelectedProject(null)
                      void actions.deleteProject(p.id)
                    }
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="settings-col">
          <div className="pane-side-title">사용자</div>
          <form
            className="settings-add"
            onSubmit={(e) => {
              e.preventDefault()
              if (userName.trim()) {
                void actions.createUser(userName.trim())
                setUserName('')
              }
            }}
          >
            <input placeholder="새 사용자 이름" value={userName} onChange={(e) => setUserName(e.target.value)} />
            <button type="submit" className="small-btn">추가</button>
          </form>
          <ul className="settings-list">
            {org.users.length === 0 && <li className="placeholder small">사용자 없음</li>}
            {org.users.map((u) => (
              <li key={u.id} className="settings-item">
                {selectedProject ? (
                  <label className="settings-assign">
                    <input type="checkbox" checked={projectUsers.includes(u.id)} onChange={() => toggleUser(u.id)} />
                    <span className="ellipsis">{u.name}</span>
                  </label>
                ) : (
                  <span className="settings-item-name ellipsis">{u.name}</span>
                )}
                <button
                  type="button"
                  className="icon-mini"
                  title="삭제"
                  onClick={() => {
                    if (window.confirm(`'${u.name}' 사용자를 삭제할까요?`)) void actions.deleteUser(u.id)
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">
            {selectedProject
              ? '체크하면 선택한 프로젝트에 사용자를 할당합니다.'
              : '왼쪽에서 프로젝트를 선택하면 사용자를 할당할 수 있어요.'}
          </p>
        </div>
      </div>
    </dialog>
  )
}
