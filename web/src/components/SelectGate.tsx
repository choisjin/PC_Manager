import { useState } from 'react'
import type { Org } from '../api'

export interface Identity {
  projectId: string | null
  userId: string | null
}

interface Props {
  org: Org
  onConfirm: (identity: Identity) => void
  onOpenSettings: () => void
}

/** 진입 시 프로젝트·사용자를 고르는 게이트 (비밀번호 없는 이름 선택) */
export function SelectGate({ org, onConfirm, onOpenSettings }: Props) {
  const [projectId, setProjectId] = useState<string | null>(null)

  const users = projectId
    ? org.users.filter((u) => (org.projectUsers[projectId] ?? []).includes(u.id))
    : []

  return (
    <div className="gate">
      <div className="gate-card">
        <h1 className="gate-title">PC Manager</h1>
        <p className="gate-sub muted">프로젝트와 사용자를 선택하세요.</p>

        <div className="gate-cols">
          <div className="gate-col">
            <div className="gate-col-title">프로젝트</div>
            {org.projects.length === 0 ? (
              <div className="gate-empty muted small">
                등록된 프로젝트가 없습니다.
                <br />
                <button type="button" className="link" onClick={onOpenSettings}>설정에서 만들기</button>
              </div>
            ) : (
              <ul className="gate-list">
                {org.projects.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`gate-item${projectId === p.id ? ' active' : ''}`}
                      onClick={() => setProjectId(p.id)}
                    >
                      {p.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="gate-col">
            <div className="gate-col-title">사용자</div>
            {!projectId ? (
              <div className="gate-empty muted small">왼쪽에서 프로젝트를 먼저 선택하세요.</div>
            ) : users.length === 0 ? (
              <div className="gate-empty muted small">
                이 프로젝트에 할당된 사용자가 없습니다.
                <br />
                <button type="button" className="link" onClick={onOpenSettings}>설정에서 할당</button>
              </div>
            ) : (
              <ul className="gate-list">
                {users.map((u) => (
                  <li key={u.id}>
                    <button type="button" className="gate-item" onClick={() => onConfirm({ projectId, userId: u.id })}>
                      {u.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="gate-actions">
          <button type="button" className="link" onClick={() => onConfirm({ projectId: null, userId: null })}>
            건너뛰기 (전체 보기)
          </button>
          <button type="button" className="link" onClick={onOpenSettings}>프로젝트·사용자 관리</button>
        </div>
      </div>
    </div>
  )
}
