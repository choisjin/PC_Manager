import { useEffect, useState } from 'react'
import { api, type LoginResult, type Org } from '../api'
import { useLang } from '../i18n/useLang'

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
  const [lang, setLang] = useLang()

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
    <div className="portal-login">
      {/* 왼쪽 브랜드 패널 (APMS 로그인과 같은 모양) */}
      <aside className="pl-hero" aria-hidden="true">
        <div className="pl-hero-logo">
          <span className="brand-logo">R</span>RemoteKit
        </div>
        <div className="pl-hero-main">
          <i className="pl-hero-bar" />
          <h1>PC Manager</h1>
          <p>파일 탐색 · 원격조작 · 결과 확인을 한 곳에서.</p>
        </div>
        <div className="pl-hero-foot">LG Electronics</div>
      </aside>

      <div className="portal-login-box">
        {!managing ? (
          <form onSubmit={(e) => void submit(e)}>
            <p className="pl-sub">프로젝트를 고르고 LG 계정으로 로그인하세요.</p>
            <label className="pl-field">
              <span>프로젝트</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={org.projects.length === 0} translate="no">
                {org.projects.length === 0 && <option value="">등록된 프로젝트가 없습니다 — [관리]에서 등록</option>}
                {org.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="pl-field">
              <span>계정 ID</span>
              <input value={username} autoComplete="username" spellCheck={false} autoFocus={!username} onChange={(e) => setUsername(e.target.value)} placeholder="ex) gildong.hong" />
              <span className="pl-hint">LG 계정은 이메일 @lge.com 앞부분 · 프로젝트 관리자는 admin</span>
            </label>
            <label className="pl-field">
              <span>비밀번호</span>
              <input type="password" value={password} autoComplete="current-password" autoFocus={!!username} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <div className="pl-checks">
              <label>
                <input type="checkbox" checked={saveId} onChange={(e) => setSaveId(e.target.checked)} /> 아이디 저장
              </label>
              <label title="이 브라우저에서 30일 동안 로그인 유지 (공용 PC 에서는 끄세요)">
                <input type="checkbox" checked={autoLogin} onChange={(e) => setAutoLogin(e.target.checked)} /> 자동 로그인
              </label>
            </div>
            {error && <p className="pl-error">{error}</p>}
            <div className="pl-actions">
              <button type="submit" className="btn-primary" disabled={busy || org.projects.length === 0}>
                {busy ? '접속 중…' : '접속'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setManaging(true)}>
                관리
              </button>
            </div>
          </form>
        ) : (
          <div>
            <p className="pl-sub">
              새 프로젝트를 등록하면 관리자 계정(계정 ID <b>admin</b> / 비밀번호 <b>admin</b>)이 함께 만들어집니다. 비밀번호는 관리자로 접속해 설정에서 바꾸세요.
            </p>
            <form className="pl-tproj-add" onSubmit={createProject}>
              <label className="pl-field">
                <span>프로젝트 이름</span>
                <input placeholder="ex) Renault_CDC" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
              </label>
              <button type="submit" className="btn-primary">
                프로젝트 등록
              </button>
            </form>
            {error && <p className="pl-error">{error}</p>}
            <div className="pl-sub2">
              현재 프로젝트 <span className="pl-hint">— 이름 수정 · 삭제는 그 프로젝트의 관리자 비밀번호가 필요합니다</span>
            </div>
            <div className="pl-proj-list">
              {org.projects.length === 0 && <div className="pl-tproj-row muted">등록된 프로젝트가 없습니다</div>}
              {org.projects.map((p) => (
                <div key={p.id} className="pl-tproj-row">
                  <span className="nm" translate="no">
                    {p.name}
                  </span>
                  <button type="button" onClick={() => renameProject(p.id, p.name)}>
                    이름 수정
                  </button>
                  <button type="button" className="danger" onClick={() => deleteProject(p.id, p.name)}>
                    삭제
                  </button>
                </div>
              ))}
            </div>
            <div className="pl-actions pl-back">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setManaging(false)
                  setError(null)
                }}
              >
                ← 접속 화면으로
              </button>
            </div>
          </div>
        )}
        <div className="pl-lang" translate="no">
          <span className="lang-seg">
            <button type="button" className={lang === 'ko' ? 'active' : ''} onClick={() => setLang('ko')}>
              한국어
            </button>
            <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>
              English
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}
