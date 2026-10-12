import { useEffect, useState } from 'react'
import { api, type LoginResult, type Org } from '../api'

const SAVED_ID_KEY = 'pcm.savedId'
const AUTO_PREF_KEY = 'pcm.autoPref'
const LAST_PROJECT_KEY = 'pcm.lastProject'

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // 무시
  }
}

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface Props {
  org: Org
  onLogin: (result: LoginResult) => void
}

/**
 * 로그인 화면 (APMS 방식): 프로젝트 선택 + 계정 ID·비밀번호.
 * 'admin' = 그 프로젝트 관리자 (기본 비밀번호 admin), 그 외 = LG 계정(사내 LDAP).
 * [관리]: 프로젝트 등록(이름만) · 이름 수정 · 삭제 (수정·삭제는 그 프로젝트 관리자 비밀번호)
 */
export function LoginGate({ org, onLogin }: Props) {
  const [projectId, setProjectId] = useState(() => read(LAST_PROJECT_KEY) ?? '')
  const [username, setUsername] = useState(() => read(SAVED_ID_KEY) ?? '')
  const [password, setPassword] = useState('')
  const [saveId, setSaveId] = useState(() => read(SAVED_ID_KEY) !== null)
  const [autoLogin, setAutoLogin] = useState(() => read(AUTO_PREF_KEY) === '1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [managing, setManaging] = useState(false)
  const [newProject, setNewProject] = useState('')

  // 고른 프로젝트가 없어지면(삭제·처음) 첫 프로젝트로
  useEffect(() => {
    if (org.projects.length > 0 && !org.projects.some((p) => p.id === projectId)) setProjectId(org.projects[0].id)
  }, [org.projects, projectId])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!projectId) {
      setError('프로젝트를 선택하세요.')
      return
    }
    if (!username.trim() || !password) {
      setError('계정 ID와 비밀번호를 입력하세요.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.login(projectId, username.trim(), password, autoLogin)
      write(LAST_PROJECT_KEY, projectId)
      write(SAVED_ID_KEY, saveId ? username.trim() : null)
      write(AUTO_PREF_KEY, autoLogin ? '1' : null)
      onLogin(result)
    } catch (err) {
      setError(toMessage(err))
      setBusy(false)
    }
  }

  const manage = async (action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const createProject = (e: React.FormEvent) => {
    e.preventDefault()
    const name = newProject.trim()
    if (!name) return
    void manage(async () => {
      await api.createProject(name)
      setNewProject('')
      window.alert(`'${name}' 프로젝트를 만들었습니다.\n관리자 계정: admin / 비밀번호 admin (로그인 후 Setting에서 바꾸세요)`)
    })
  }

  const renameProject = (id: string, current: string) => {
    const name = window.prompt('새 프로젝트 이름', current)?.trim()
    if (!name || name === current) return
    const pw = window.prompt(`'${current}' 관리자 비밀번호`)
    if (!pw) return
    void manage(() => api.renameProject(id, name, pw))
  }

  const deleteProject = (id: string, name: string) => {
    if (!window.confirm(`'${name}' 프로젝트를 삭제할까요?\n사용자 권한·PC/폴더 배정·관리자 계정이 함께 삭제되고 되돌릴 수 없습니다.`)) return
    const pw = window.prompt(`'${name}' 관리자 비밀번호`)
    if (!pw) return
    void manage(() => api.deleteProject(id, pw))
  }

  return (
    <div className="gate">
      <div className="gate-card login-card">
        <h1 className="gate-title">PC Manager</h1>
        <p className="gate-sub muted">프로젝트를 고르고 LG 계정으로 로그인하세요.</p>

        <form className="login-form" onSubmit={(e) => void submit(e)}>
          <label className="login-field">
            <span>프로젝트</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={org.projects.length === 0}>
              {org.projects.length === 0 && <option value="">등록된 프로젝트가 없습니다 — [관리]에서 등록</option>}
              {org.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="login-field">
            <span>계정 ID</span>
            <input value={username} autoComplete="username" autoFocus={!username} onChange={(e) => setUsername(e.target.value)} placeholder="gildong.hong" />
            <small className="muted">LG 계정은 이메일 @lge.com 앞부분 · 프로젝트 관리자는 admin</small>
          </label>
          <label className="login-field">
            <span>비밀번호</span>
            <input type="password" value={password} autoComplete="current-password" autoFocus={!!username} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <div className="login-options">
            <label>
              <input type="checkbox" checked={saveId} onChange={(e) => setSaveId(e.target.checked)} /> 아이디 저장
            </label>
            <label title="이 브라우저에서 30일 동안 로그인 유지">
              <input type="checkbox" checked={autoLogin} onChange={(e) => setAutoLogin(e.target.checked)} /> 자동 로그인
            </label>
          </div>
          {error && <div className="output-error">{error}</div>}
          <div className="login-actions">
            <button type="button" className="link" onClick={() => setManaging((v) => !v)}>
              관리
            </button>
            <button type="submit" className="primary" disabled={busy || org.projects.length === 0}>
              {busy ? '접속 중…' : '접속'}
            </button>
          </div>
        </form>

        {managing && (
          <div className="login-manage">
            <div className="gate-col-title">프로젝트 관리</div>
            <ul className="gate-list">
              {org.projects.map((p) => (
                <li key={p.id} className="login-manage-row">
                  <span className="ellipsis">{p.name}</span>
                  <button type="button" className="small-btn" onClick={() => renameProject(p.id, p.name)}>
                    이름 수정
                  </button>
                  <button type="button" className="small-btn danger" onClick={() => deleteProject(p.id, p.name)}>
                    삭제
                  </button>
                </li>
              ))}
            </ul>
            <form className="settings-add" onSubmit={createProject}>
              <input placeholder="새 프로젝트 이름" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
              <button type="submit" className="small-btn">
                프로젝트 등록
              </button>
            </form>
            <p className="muted small">새 프로젝트에는 관리자 계정(admin / 비밀번호 admin)이 함께 만들어집니다. 이름 수정·삭제는 그 프로젝트 관리자 비밀번호로 확인합니다.</p>
          </div>
        )}
      </div>
    </div>
  )
}
