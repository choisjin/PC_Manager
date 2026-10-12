import { useEffect, useRef, useState } from 'react'
import type { OrgUser, Project } from '../api'
import { useLang } from '../i18n/useLang'

interface Props {
  user: OrgUser
  project: Project
  isAdmin: boolean
  onLogout: () => void
}

/** 우측 끝 사용자 프로필 (APMS 와 같은 모양): 아바타 · 이름(직급) · 둘째 줄(권한 · 팀). 누르면 계정 메뉴 */
export function UserBox({ user, project, isAdmin, onLogout }: Props) {
  const [open, setOpen] = useState(false)
  const [lang, setLang] = useLang()
  const boxRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  // 메뉴 밖을 누르거나 Esc · 창이 포커스를 잃으면 닫기
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      btnRef.current?.focus()
    }
    const onBlur = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const builtin = user.id.startsWith('admin@') // 프로젝트 기본 관리자 계정 (이름 '관리자')
  const name = [user.name, user.title].filter(Boolean).join(' ') || '-'
  const sub = builtin ? '프로젝트 기본 관리자' : [isAdmin ? '관리자' : '', user.team].filter(Boolean).join(' · ') || '사용자'
  const initial = (user.name.trim().charAt(0) || '?').toUpperCase()
  // [이름, 값, 권한 배지?, 값을 번역할지 (사용자 데이터는 번역 안 함)]
  const rows: [string, string, boolean, boolean][] = (
    [
      ['프로젝트', project.name, false, false],
      ['권한', isAdmin ? '관리자' : '사용자', true, true],
      ['팀', user.team ?? '', false, false],
      ['부서', user.department ?? '', false, false],
      ['계정', user.ldapId ? `${user.ldapId} (LG 계정)` : builtin ? 'admin (프로젝트 관리자)' : user.id, false, !!user.ldapId || builtin],
    ] as [string, string, boolean, boolean][]
  ).filter(([, v]) => v)

  return (
    <div className="userbox" ref={boxRef}>
      <button
        type="button"
        ref={btnRef}
        className={`user-btn${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={[name, user.team, user.department, user.ldapId, user.email].filter(Boolean).join(' · ')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-avatar" aria-hidden="true" translate="no">
          {initial}
        </span>
        <span className="user-text">
          <span className="user-name" translate={builtin ? undefined : 'no'}>
            {name}
          </span>
          <span className="user-sub">{sub}</span>
        </span>
        <svg className="user-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="user-menu" role="menu">
          <div className="um-head">
            <span className="user-avatar lg" aria-hidden="true" translate="no">
              {initial}
            </span>
            <div className="um-who">
              <b translate={builtin ? undefined : 'no'}>{name}</b>
              {(user.email || (!builtin && user.ldapId)) && <small translate="no">{user.email || user.ldapId}</small>}
            </div>
          </div>
          <dl className="um-info">
            {rows.map(([k, v, role, translatable]) => (
              <div key={k} className="um-row">
                <dt>{k}</dt>
                <dd translate={translatable ? undefined : 'no'}>{role ? <span className={`um-role${isAdmin ? ' admin' : ''}`}>{v}</span> : v}</dd>
              </div>
            ))}
          </dl>
          <div className="um-actions">
            <div className="um-lang" role="group" aria-label="Language">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span className="um-lang-label">Language</span>
              <span className="lang-seg" translate="no">
                <button type="button" className={lang === 'ko' ? 'active' : ''} onClick={() => setLang('ko')}>
                  한국어
                </button>
                <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>
                  English
                </button>
              </span>
            </div>
            <button
              type="button"
              className="um-item"
              role="menuitem"
              title="로그아웃하고 다른 계정으로 접속"
              onClick={() => {
                setOpen(false)
                onLogout()
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span>사용자 변경</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 설정 톱니바퀴 (APMS 와 같은 아이콘) */
export function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
