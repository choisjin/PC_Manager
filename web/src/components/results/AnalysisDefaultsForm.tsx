import { useState } from 'react'
import { DETECT_DEFAULTS, type DetectParams, formKey, PARAM_GROUPS, type ParamKey, type ProjectParams } from './analysisDefaults'

// 프로젝트 영상 분석 기준값 고치기 (영상 분석 [⚙ 기준값] 창 · 설정 화면): 묶음별 칸, 기본값과 다른 칸은 기본값을 곁에 보인다

const ALL_FIELDS = PARAM_GROUPS.flatMap((g) => g.fields)
const textOf = (p: DetectParams) => Object.fromEntries(ALL_FIELDS.map((f) => [f.key, String(p[f.key])])) as Record<ParamKey, string>

/** 칸 글 → 값 (숫자가 아니거나 범위 밖이면 null) */
function valueOf(key: ParamKey, text: string): number | null {
  const f = ALL_FIELDS.find((x) => x.key === key)!
  const v = Number(text)
  return text.trim() !== '' && Number.isFinite(v) && v >= f.min && v <= f.max ? v : null
}

export function AnalysisDefaultsForm({ project, userName, onDone }: {
  project: ProjectParams
  /** 마지막으로 바꾼 사용자 이름 */
  userName?: (id: string | null | undefined) => string | null
  /** 저장·취소 뒤 (창이면 닫기) */
  onDone?: () => void
}) {
  const [draft, setDraft] = useState(() => textOf(project.params))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const parsed = ALL_FIELDS.map((f) => [f.key, valueOf(f.key, draft[f.key])] as const)
  const invalid = parsed.some(([, v]) => v === null)
  const dirty = parsed.some(([k, v]) => v !== project.params[k])

  const save = async () => {
    if (invalid) return
    setSaving(true)
    setError(null)
    try {
      await project.save(Object.fromEntries(parsed) as unknown as DetectParams)
      setSavedAt(Date.now())
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const by = project.view?.updatedBy ? userName?.(project.view.updatedBy) ?? null : null
  const at = project.view?.updatedAt ? new Date(project.view.updatedAt).toLocaleString() : null
  return (
    <div className="va-defaults">
      <p className="hint">
        이 프로젝트의 모든 영상 분석에 쓰는 판정 기준입니다. 장치 사양(깜박임·검은 화면 길이, 응답 시간 등)에 맞게 바꾸면 결과 확인을 다시 열 때(열려 있으면 바로) 다시 판정합니다.
        정지 기준·화면 밝기 차이·지연 기준은 새 분석의 처음 값이고, 분석마다 화면에서 바꾼 값이 있으면 그 값을 씁니다.
      </p>
      {!project.projectId && <p className="error small">로그인한 프로젝트를 몰라 기본값을 씁니다 (저장할 수 없음)</p>}
      {project.error && <p className="error small">{`기준값을 읽지 못해 기본값을 씁니다: ${project.error}`}</p>}
      {PARAM_GROUPS.map((g) => (
        <fieldset key={g.title} className="va-defaults-group">
          <legend>{g.title}</legend>
          {g.fields.map((f) => {
            const v = valueOf(f.key, draft[f.key])
            const changed = v !== null && v !== DETECT_DEFAULTS[f.key]
            return (
              <label key={f.key} className="va-defaults-row" title={f.hint}>
                <span className="va-defaults-label">{f.label}</span>
                <span className="va-defaults-input">
                  <input
                    type="number"
                    min={f.min}
                    max={f.max}
                    step="any"
                    value={draft[f.key]}
                    aria-invalid={v === null}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  />
                  <span className="muted">{f.unit}</span>
                </span>
                <span className={`va-defaults-base small${changed ? ' changed' : ' muted'}`}>
                  {v === null ? `${f.min} ~ ${f.max}` : changed ? `기본 ${DETECT_DEFAULTS[f.key]}` : '기본값'}
                </span>
                <span className="va-defaults-hint small muted">{f.hint}</span>
              </label>
            )
          })}
        </fieldset>
      ))}
      {error && <p className="error small">{error}</p>}
      <div className="va-defaults-actions">
        <span className="small muted">
          {savedAt !== null ? '저장했습니다' : by || at ? `마지막 변경: ${[by, at].filter(Boolean).join(' · ')}` : ''}
        </span>
        <span className="rv-spacer" />
        <button type="button" onClick={() => setDraft(textOf(DETECT_DEFAULTS))} title="모든 칸을 기본값으로 (저장해야 적용)">모두 기본값</button>
        {onDone && <button type="button" onClick={onDone}>취소</button>}
        <button type="button" className="primary" disabled={!dirty || invalid || saving || !project.projectId || !project.loaded} onClick={() => void save()}>
          {saving ? '저장 중…' : project.loaded ? '저장' : '읽는 중…'}
        </button>
      </div>
    </div>
  )
}

/** 영상 분석 패널의 [⚙ 기준값] 창 */
export function AnalysisDefaultsDialog({ project, onClose }: { project: ProjectParams; onClose: () => void }) {
  return (
    <div className="rv-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rv-modal-box panel wide">
        <div className="rv-drawer-head">
          <strong>영상 분석 기준값 (프로젝트)</strong>
          <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <AnalysisDefaultsForm key={formKey(project)} project={project} onDone={onClose} />
      </div>
    </div>
  )
}
