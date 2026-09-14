import { useMemo, useState } from 'react'
import { api, type Agent, type JobRunDetail, type JobStep, type JobStepKind, type ShellKind } from '../api'

interface Props {
  agents: Agent[]
  selectedAgentIds: ReadonlySet<string>
  onCreated: (detail: JobRunDetail) => void
}

type TargetMode = 'selected' | 'tags'

const newStep = (kind: JobStepKind): JobStep => ({
  kind,
  name: null,
  shell: 'Cmd',
  commandLine: kind === 'Command' ? '' : null,
  workingDirectory: null,
  timeoutSeconds: 600,
  encoding: null,
  sourceDirectory: null,
  patterns: kind === 'Collect' ? ['**/*'] : [],
  continueOnError: false,
})

// 테스트가 실패(종료 코드 ≠ 0)해도 결과는 수집하는 기본 구성
const defaultSteps = (): JobStep[] => [
  { ...newStep('Command'), name: '테스트 실행', continueOnError: true },
  { ...newStep('Collect'), name: '결과 수집' },
]

export function JobForm({ agents, selectedAgentIds, onCreated }: Props) {
  const [name, setName] = useState('')
  const [targetMode, setTargetMode] = useState<TargetMode>('selected')
  const [tags, setTags] = useState<Set<string>>(() => new Set())
  const [maxParallel, setMaxParallel] = useState(0)
  const [steps, setSteps] = useState<JobStep[]>(defaultSteps)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allTags = useMemo(
    () => [...new Set(agents.flatMap((a) => a.tags))].sort((a, b) => a.localeCompare(b)),
    [agents],
  )

  const targetCount = useMemo(() => {
    if (targetMode === 'selected') return selectedAgentIds.size
    const wanted = [...tags].map((t) => t.toLowerCase())
    return agents.filter((a) => a.tags.some((t) => wanted.includes(t.toLowerCase()))).length
  }, [agents, selectedAgentIds, tags, targetMode])

  const updateStep = (index: number, patch: Partial<JobStep>) =>
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))

  const moveStep = (index: number, delta: number) =>
    setSteps((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.length) return prev
      const next = prev.slice()
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })

  const toggleTag = (tag: string) =>
    setTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onCreated(
        await api.createJob({
          name: name.trim() || null,
          agentIds: targetMode === 'selected' ? [...selectedAgentIds] : [],
          tags: targetMode === 'tags' ? [...tags] : [],
          maxParallel,
          steps: steps.map((s) => ({ ...s, patterns: s.patterns.map((p) => p.trim()).filter(Boolean) })),
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel job-form">
      <div className="panel-head">
        <h2>새 Job</h2>
        <button type="button" className="link" onClick={() => setSteps(defaultSteps())}>
          기본 구성으로
        </button>
      </div>

      <div className="job-form-body">
        <div className="form-row">
          <label>
            이름
            <input value={name} placeholder="비우면 실행 시각" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="narrow">
            동시 실행 PC 수
            <input
              type="number"
              min={0}
              value={maxParallel}
              title="0이면 제한 없음"
              onChange={(e) => setMaxParallel(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
          </label>
        </div>

        <fieldset className="target-box">
          <legend>대상</legend>
          <div className="target-modes">
            <label className="check">
              <input
                type="radio"
                name="target-mode"
                checked={targetMode === 'selected'}
                onChange={() => setTargetMode('selected')}
              />
              왼쪽에서 선택한 PC ({selectedAgentIds.size}대)
            </label>
            <label className="check">
              <input
                type="radio"
                name="target-mode"
                checked={targetMode === 'tags'}
                onChange={() => setTargetMode('tags')}
              />
              태그
            </label>
          </div>
          {targetMode === 'tags' && (
            <div className="tags">
              {allTags.length === 0 && <span className="muted small">태그가 있는 PC가 없습니다</span>}
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`tag-toggle${tags.has(tag) ? ' active' : ''}`}
                  aria-pressed={tags.has(tag)}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </fieldset>

        <ol className="steps">
          {steps.map((step, index) => (
            <li key={index} className="step">
              <div className="step-head">
                <span className="step-no">{index + 1}</span>
                <select
                  value={step.kind}
                  aria-label="단계 종류"
                  onChange={(e) => updateStep(index, { ...newStep(e.target.value as JobStepKind), name: step.name })}
                >
                  <option value="Command">명령 실행</option>
                  <option value="Collect">결과 수집</option>
                </select>
                <input
                  value={step.name ?? ''}
                  placeholder="단계 이름 (선택)"
                  onChange={(e) => updateStep(index, { name: e.target.value || null })}
                />
                <span className="step-actions">
                  <button type="button" className="icon" title="위로" disabled={index === 0} onClick={() => moveStep(index, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon"
                    title="아래로"
                    disabled={index === steps.length - 1}
                    onClick={() => moveStep(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="icon"
                    title="삭제"
                    disabled={steps.length === 1}
                    onClick={() => setSteps((prev) => prev.filter((_, i) => i !== index))}
                  >
                    ✕
                  </button>
                </span>
              </div>

              {step.kind === 'Command' ? (
                <div className="step-body">
                  <div className="segmented" role="radiogroup" aria-label="셸">
                    {(['Cmd', 'PowerShell'] as ShellKind[]).map((shell) => (
                      <button
                        key={shell}
                        type="button"
                        role="radio"
                        aria-checked={step.shell === shell}
                        className={step.shell === shell ? 'active' : ''}
                        onClick={() => updateStep(index, { shell })}
                      >
                        {shell === 'Cmd' ? 'CMD' : 'PowerShell'}
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="mono"
                    rows={2}
                    spellCheck={false}
                    value={step.commandLine ?? ''}
                    placeholder={
                      step.shell === 'Cmd'
                        ? '예: pytest --junitxml=%PCM_RESULT_DIR%\\junit.xml'
                        : '예: pytest --junitxml="$env:PCM_RESULT_DIR\\junit.xml"'
                    }
                    onChange={(e) => updateStep(index, { commandLine: e.target.value })}
                  />
                  <div className="form-row">
                    <label>
                      작업 폴더
                      <input
                        className="mono"
                        value={step.workingDirectory ?? ''}
                        placeholder="비우면 에이전트 기본 작업 폴더"
                        onChange={(e) => updateStep(index, { workingDirectory: e.target.value || null })}
                      />
                    </label>
                    <label className="narrow">
                      제한 시간(초)
                      <input
                        type="number"
                        min={0}
                        value={step.timeoutSeconds}
                        onChange={(e) =>
                          updateStep(index, { timeoutSeconds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
                        }
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <div className="step-body">
                  <div className="form-row">
                    <label>
                      수집 폴더
                      <input
                        className="mono"
                        value={step.sourceDirectory ?? ''}
                        placeholder="비우면 PCM_RESULT_DIR (이 Job의 결과 폴더)"
                        onChange={(e) => updateStep(index, { sourceDirectory: e.target.value || null })}
                      />
                    </label>
                    <label>
                      파일 패턴 (줄마다 하나)
                      <textarea
                        className="mono"
                        rows={2}
                        spellCheck={false}
                        value={step.patterns.join('\n')}
                        placeholder="**/*"
                        onChange={(e) => updateStep(index, { patterns: e.target.value.split('\n') })}
                      />
                    </label>
                  </div>
                </div>
              )}

              <label className="check step-continue">
                <input
                  type="checkbox"
                  checked={step.continueOnError}
                  onChange={(e) => updateStep(index, { continueOnError: e.target.checked })}
                />
                실패해도 다음 단계 진행 (PC 결과는 실패로 기록)
              </label>
            </li>
          ))}
        </ol>

        <div className="step-add">
          <button type="button" onClick={() => setSteps((prev) => [...prev, newStep('Command')])}>
            + 명령 실행
          </button>
          <button type="button" onClick={() => setSteps((prev) => [...prev, newStep('Collect')])}>
            + 결과 수집
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        <div className="job-submit">
          <p className="hint">
            명령은 <code>%PCM_RESULT_DIR%</code>(PowerShell: <code>$env:PCM_RESULT_DIR</code>)에 결과를 저장하세요.
          </p>
          <button type="button" className="primary" disabled={busy || targetCount === 0} onClick={() => void submit()}>
            {busy ? '요청 중…' : `${targetCount}대에서 Job 실행`}
          </button>
        </div>
      </div>
    </section>
  )
}
