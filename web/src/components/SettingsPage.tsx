import { useState } from 'react'
import { api, type Agent, type Org, type OrgUser, type PcGroups } from '../api'
import { FEATURES } from '../perms'
import { useLang } from '../i18n/useLang'
import { AddAgentDialog } from './AddAgentDialog'
import { EditFolderSection } from './EditFolderSection'
import { displayName } from './explorer/pcGroups'

interface Props {
  org: Org
  agents: Agent[]
  pcGroups: PcGroups
  /** 대시보드를 연 PC의 에이전트 (편집 폴더 관리) */
  selfAgentId: string | null
  /** 로그인 세션 (관리자 API에 쓴다) */
  token: string
  projectId: string
  isAdmin: boolean
  /** 관리자가 아니고 쓸 수 있는 기능이 하나도 없음 */
  noPerms: boolean
}

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

const formatLogin = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Setting 페이지: (관리자) 인원 권한 · 프로젝트 구성 · 관리자 비밀번호, (모두) PC 추가·인증서 · 편집 폴더 */
export function SettingsPage({ org, agents, pcGroups, selfAgentId, token, projectId, isAdmin, noPerms }: Props) {
  const [addingPc, setAddingPc] = useState(false)

  return (
    <div className="settings-page">
      <GeneralSection />
      {noPerms && (
        <section className="panel settings-section">
          <p className="no-perms">아직 권한이 없습니다. 프로젝트 관리자에게 요청하세요.</p>
        </section>
      )}
      {isAdmin && (
        <>
          <PermissionSection org={org} token={token} projectId={projectId} />
          <ProjectSection org={org} agents={agents} pcGroups={pcGroups} projectId={projectId} />
          <AdminPasswordSection token={token} />
        </>
      )}
      {/* PC 추가 · 인증서 */}
      <section className="panel settings-section">
        <div className="settings-section-head">
          <h2>PC 추가 · 인증서</h2>
          <button type="button" className="primary" onClick={() => setAddingPc(true)}>
            열기
          </button>
        </div>
        <p className="muted small">
          테스트 PC에 설치할 에이전트 설치 파일과 서버 주소, 그리고 이 대시보드를 HTTPS로 경고 없이 열기 위한 인증서 설치 도구가
          있습니다. 인증서 설치 도구는 대시보드를 여는 PC마다 한 번 실행합니다 (에이전트가 설치된 PC는 자동).
        </p>
      </section>
      {addingPc && <AddAgentDialog onClose={() => setAddingPc(false)} />}
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

/** 일반 설정: 화면 언어 (이 브라우저에 저장) */
function GeneralSection() {
  const [lang, setLang] = useLang()
  return (
    <section className="panel settings-section">
      <div className="settings-section-head">
        <h2>일반 설정</h2>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">Language</span>
        <span className="lang-seg" translate="no">
          <button type="button" className={lang === 'ko' ? 'active' : ''} onClick={() => setLang('ko')}>
            한국어
          </button>
          <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>
            English
          </button>
        </span>
        <span className="muted small">화면 언어는 이 브라우저에 저장됩니다.</span>
      </div>
    </section>
  )
}

/**
 * 인원 권한 (APMS 방식): LG 계정으로 로그인한 사람 × 기능 체크박스. 체크하면 바로 저장.
 * 이 프로젝트에 처음 로그인하면 전체 기능이고 '미분류'로 보인다 → 관리자가 조정하면 '권한 설정됨'.
 */
function PermissionSection({ org, token, projectId }: { org: Org; token: string; projectId: string }) {
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const perms = org.projectPerms?.[projectId] ?? {}
  const reviewed = new Set(org.permReviewed?.[projectId] ?? [])
  const q = filter.trim().toLowerCase()
  const users = org.users
    .filter((u) => u.role !== 'admin')
    .filter((u) => !q || [u.name, u.ldapId, u.title, u.team].some((v) => v?.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  const groups: { title: string; users: OrgUser[] }[] = [
    { title: '미분류 — 처음 로그인해 전체 기능을 받은 사람 (조정하면 아래로)', users: users.filter((u) => u.id in perms && !reviewed.has(u.id)) },
    { title: '권한 설정됨', users: users.filter((u) => u.id in perms && reviewed.has(u.id)) },
    { title: '이 프로젝트에 로그인한 적 없음', users: users.filter((u) => !(u.id in perms)) },
  ]

  const save = (userId: string, next: string[]) => {
    setError(null)
    api.setUserPerms(token, userId, next).catch((err) => setError(toMessage(err)))
  }

  return (
    <section className="panel settings-section">
      <div className="settings-section-head">
        <h2>인원 권한</h2>
        <input className="perm-filter" placeholder="이름·ID·팀 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {error && <div className="output-error">{error}</div>}
      {users.length === 0 ? (
        <p className="muted small">{q ? '검색 결과가 없습니다.' : '아직 LG 계정으로 로그인한 사람이 없습니다.'}</p>
      ) : (
        <div className="matrix-wrap">
          <table className="matrix perm-table">
            <thead>
              <tr>
                <th className="perm-name">이름</th>
                <th className="perm-name">직급</th>
                <th className="perm-name">팀</th>
                <th className="perm-name">마지막 로그인</th>
                <th>전체</th>
                {FEATURES.map((f) => (
                  <th key={f.id} title={f.hint}>
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            {groups
              .filter((g) => g.users.length > 0)
              .map((g) => (
                <tbody key={g.title}>
                  <tr className="perm-group">
                    <td colSpan={5 + FEATURES.length}>
                      {g.title} ({g.users.length})
                    </td>
                  </tr>
                  {g.users.map((u) => {
                    const mine = perms[u.id] ?? []
                    const all = FEATURES.every((f) => mine.includes(f.id))
                    return (
                      <tr key={u.id}>
                        <td className="perm-name" translate="no" title={u.ldapId ?? undefined}>
                          <b>{u.name}</b>
                        </td>
                        <td className="perm-name small" translate="no">{u.title}</td>
                        <td className="perm-name small" translate="no" title={u.department ?? undefined}>
                          {u.team}
                        </td>
                        <td className="perm-name small muted">{formatLogin(u.lastLogin)}</td>
                        <td>
                          <input type="checkbox" checked={all} aria-label={`${u.name} 전체`} onChange={() => save(u.id, all ? [] : FEATURES.map((f) => f.id))} />
                        </td>
                        {FEATURES.map((f) => (
                          <td key={f.id}>
                            <input
                              type="checkbox"
                              checked={mine.includes(f.id)}
                              aria-label={`${u.name} ${f.label}`}
                              onChange={() => save(u.id, mine.includes(f.id) ? mine.filter((x) => x !== f.id) : [...mine, f.id])}
                            />
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              ))}
          </table>
        </div>
      )}
      <p className="muted small">
        LG 계정으로 이 프로젝트에 처음 로그인하면 모든 기능을 받습니다. 체크를 바꾸면 바로 저장되고, 그 사람 화면에도 곧바로 반영됩니다. 모두 끄면 그 사람은 로그인해도 쓸 수 있는 기능이 없습니다.
      </p>
    </section>
  )
}

/** 지금 프로젝트 구성: 멤버 · PC · 폴더 (배정은 PC Manager 화면에서 우클릭) */
function ProjectSection({ org, agents, pcGroups, projectId }: { org: Org; agents: Agent[]; pcGroups: PcGroups; projectId: string }) {
  const project = org.projects.find((p) => p.id === projectId)
  const members = (org.projectUsers[projectId] ?? [])
    .map((id) => org.users.find((u) => u.id === id))
    .filter((u): u is OrgUser => !!u && u.role !== 'admin')
    .map((u) => u.name)
  const pcs = agents.filter((a) => org.agentProjects[a.id] === projectId)
  const folders = pcGroups.folders.filter((f) => org.folderProjects?.[f.id] === projectId).map((f) => f.name)
  return (
    <section className="panel settings-section">
      <div className="settings-section-head">
        <h2>프로젝트 구성{project ? ` — ${project.name}` : ''}</h2>
      </div>
      <div className="project-card">
        <div className="project-card-row">
          <span className="project-card-label">멤버 {members.length}</span>
          <span className="chips">{members.length ? members.map((m) => <span key={m} className="chip">{m}</span>) : <span className="muted small">없음</span>}</span>
        </div>
        <div className="project-card-row">
          <span className="project-card-label">PC {pcs.length}</span>
          <span className="chips">
            {pcs.length ? pcs.map((a) => <span key={a.id} className={`chip${a.online ? '' : ' off'}`}>{displayName(a, pcGroups)}</span>) : <span className="muted small">없음</span>}
          </span>
        </div>
        {folders.length > 0 && (
          <div className="project-card-row">
            <span className="project-card-label">폴더 {folders.length}</span>
            <span className="chips">{folders.map((f) => <span key={f} className="chip folder">📂 {f}</span>)}</span>
          </div>
        )}
      </div>
      <p className="muted small">
        프로젝트에 배정된 PC·폴더는 그 프로젝트로 로그인한 사람에게만 보입니다 (배정 없는 PC는 모두에게). 배정은 PC Manager 화면에서 PC·폴더를 우클릭해서 합니다.
        프로젝트 등록·이름 수정·삭제는 로그인 화면의 [관리]에서 합니다.
      </p>
    </section>
  )
}

/** 이 프로젝트 관리자(admin) 비밀번호 변경 */
function AdminPasswordSection({ token }: { token: string }) {
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (newPw !== confirmPw) {
      setMessage({ ok: false, text: '새 비밀번호가 서로 다릅니다.' })
      return
    }
    api.changeAdminPassword(token, oldPw, newPw).then(
      () => {
        setOldPw('')
        setNewPw('')
        setConfirmPw('')
        setMessage({ ok: true, text: '비밀번호를 바꿨습니다. 다른 브라우저의 관리자 자동 로그인은 해제됩니다.' })
      },
      (err) => setMessage({ ok: false, text: toMessage(err) }),
    )
  }

  return (
    <section className="panel settings-section">
      <div className="settings-section-head">
        <h2>관리자 비밀번호</h2>
      </div>
      <form className="admin-password-form" onSubmit={submit}>
        <input type="password" placeholder="현재 비밀번호" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
        <input type="password" placeholder="새 비밀번호 (4자 이상)" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        <input type="password" placeholder="새 비밀번호 확인" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
        <button type="submit" className="small-btn" disabled={!oldPw || !newPw}>
          변경
        </button>
      </form>
      {message && <p className={message.ok ? 'muted small' : 'output-error'}>{message.text}</p>}
      <p className="muted small">처음 비밀번호는 admin입니다. 로그인 화면에서 계정 ID에 admin을 넣으면 이 프로젝트 관리자로 들어옵니다.</p>
    </section>
  )
}
