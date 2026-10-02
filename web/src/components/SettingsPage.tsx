import { useState } from 'react'
import type { Agent, Org, PcGroups } from '../api'
import type { OrgActions } from '../useDashboard'
import { EditFolderSection } from './EditFolderSection'
import { displayName } from './explorer/pcGroups'

interface Props {
  org: Org
  actions: OrgActions
  agents: Agent[]
  pcGroups: PcGroups
  /** 대시보드를 연 PC의 에이전트 (편집 폴더 관리) */
  selfAgentId: string | null
}

/** Setting 페이지: 프로젝트·사용자 관리, 사용자×프로젝트 매트릭스, 프로젝트별 구성 요약 */
export function SettingsPage({ org, actions, agents, pcGroups, selfAgentId }: Props) {
  const [projectName, setProjectName] = useState('')
  const [userName, setUserName] = useState('')

  const inProject = (projectId: string, userId: string) => (org.projectUsers[projectId] ?? []).includes(userId)
  const toggle = (projectId: string, userId: string) => {
    const cur = org.projectUsers[projectId] ?? []
    void actions.setProjectUsers(projectId, inProject(projectId, userId) ? cur.filter((id) => id !== userId) : [...cur, userId])
  }
  const usersOf = (projectId: string) => (org.projectUsers[projectId] ?? []).map((id) => org.users.find((u) => u.id === id)?.name ?? '?')
  const agentsOf = (projectId: string) => agents.filter((a) => org.agentProjects[a.id] === projectId)
  const foldersOf = (projectId: string) =>
    pcGroups.folders.filter((f) => org.folderProjects?.[f.id] === projectId).map((f) => f.name)
  const projectsOfUser = (userId: string) => org.projects.filter((p) => inProject(p.id, userId)).map((p) => p.name)

  return (
    <div className="settings-page">
      {/* 1. 프로젝트 관리 */}
      <section className="panel settings-section">
        <div className="settings-section-head">
          <h2>프로젝트</h2>
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
        </div>
        {org.projects.length === 0 && <p className="muted small">프로젝트가 없습니다. 위에서 추가하세요.</p>}
        <div className="project-cards">
          {org.projects.map((p) => {
            const members = usersOf(p.id)
            const pcs = agentsOf(p.id)
            const folders = foldersOf(p.id)
            return (
              <div key={p.id} className="project-card">
                <div className="project-card-head">
                  <b className="ellipsis">{p.name}</b>
                  <span className="project-card-actions">
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
                        if (window.confirm(`'${p.name}' 프로젝트를 삭제할까요? (사용자·PC·폴더 배정이 해제됩니다)`)) void actions.deleteProject(p.id)
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div className="project-card-row">
                  <span className="project-card-label">사용자 {members.length}</span>
                  <span className="chips">{members.length ? members.map((m) => <span key={m} className="chip">{m}</span>) : <span className="muted small">없음 (모두 접근 가능)</span>}</span>
                </div>
                <div className="project-card-row">
                  <span className="project-card-label">PC {pcs.length}</span>
                  <span className="chips">{pcs.length ? pcs.map((a) => <span key={a.id} className={`chip${a.online ? '' : ' off'}`}>{displayName(a, pcGroups)}</span>) : <span className="muted small">없음</span>}</span>
                </div>
                {folders.length > 0 && (
                  <div className="project-card-row">
                    <span className="project-card-label">폴더 {folders.length}</span>
                    <span className="chips">{folders.map((f) => <span key={f} className="chip folder">📂 {f}</span>)}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* 2. 사용자 × 프로젝트 매트릭스 */}
      <section className="panel settings-section">
        <div className="settings-section-head">
          <h2>사용자 · 프로젝트 배정</h2>
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
        </div>
        {org.users.length === 0 ? (
          <p className="muted small">사용자가 없습니다. 위에서 추가하세요.</p>
        ) : (
          <div className="matrix-wrap">
            <table className="matrix">
              <thead>
                <tr>
                  <th className="matrix-user">사용자</th>
                  {org.projects.map((p) => (
                    <th key={p.id} className="matrix-proj" title={p.name}>
                      <span className="ellipsis">{p.name}</span>
                    </th>
                  ))}
                  <th className="matrix-summary">소속</th>
                  <th className="matrix-del" />
                </tr>
              </thead>
              <tbody>
                {org.users.map((u) => (
                  <tr key={u.id}>
                    <td className="matrix-user">
                      <b>{u.name}</b>
                    </td>
                    {org.projects.map((p) => (
                      <td key={p.id} className="matrix-cell">
                        <input type="checkbox" checked={inProject(p.id, u.id)} onChange={() => toggle(p.id, u.id)} aria-label={`${u.name} → ${p.name}`} />
                      </td>
                    ))}
                    <td className="matrix-summary small muted">{projectsOfUser(u.id).join(', ') || '—'}</td>
                    <td className="matrix-del">
                      <button
                        type="button"
                        className="icon-mini"
                        title="사용자 삭제"
                        onClick={() => {
                          if (window.confirm(`'${u.name}' 사용자를 삭제할까요?`)) void actions.deleteUser(u.id)
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {org.projects.length === 0 && <p className="muted small">프로젝트를 만들면 여기서 체크로 배정할 수 있습니다.</p>}
          </div>
        )}
        <p className="muted small">
          체크하면 그 프로젝트에 배정됩니다. 프로젝트에 배정된 PC·폴더는 그 프로젝트 사용자에게만 보입니다. PC·폴더 배정은 PC Manager 화면에서 우클릭으로 합니다.
        </p>
      </section>
      {/* 편집 폴더 */}
      <EditFolderSection
        selfAgentId={selfAgentId}
        selfName={(() => {
          const a = agents.find((x) => x.id === selfAgentId)
          return a ? displayName(a, pcGroups) : null
        })()}
      />
    </div>
  )
}
