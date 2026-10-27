import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type AnalysisDefaultsView, currentProject } from '../../api'
import { CYCLE_DIFF_DEFAULT, CYCLE_PARAM_DEFAULTS, type CycleParams, DELAY_DEFAULT } from './videoCycle'
import { DETECTOR_DEFAULTS, type DetectorParams } from './videoDetect'

// 영상 분석 기준값 (프로젝트별): 검출 판정(videoDetect)·Cycle 비교(videoCycle)가 쓰는 값을 장치 사양에 맞게 바꾼다.
// 서버에는 기본값과 다른 값만 이름 → 값으로 저장한다 (없는 값은 여기 기본값). 정지 기준·밝기 차이·지연은 새 분석의 처음 값이고
// 분석마다 화면에서 바꾼 값이 있으면 그것을 쓴다

/** 기준값 (초 · % · 밝기 단계 0~255): 판정(DetectorParams) · Cycle 비교(CycleParams) · 새 분석의 처음 값 셋. 뜻은 PARAM_GROUPS 설명 */
export interface DetectParams extends DetectorParams, CycleParams {
  /** 정지 기준 (초) */
  staticS: number
  /** Cycle 비교 밝기 차이 (0~255) */
  cycleDiff: number
  /** 지연 기준 (초) */
  delayS: number
}

/** 기본 정지 기준 (초) */
export const STATIC_DEFAULT = 10

export const DETECT_DEFAULTS: DetectParams = {
  ...DETECTOR_DEFAULTS, ...CYCLE_PARAM_DEFAULTS, staticS: STATIC_DEFAULT, cycleDiff: CYCLE_DIFF_DEFAULT, delayS: DELAY_DEFAULT,
}

export type ParamKey = keyof DetectParams

/** 화면에 보이는 기준값: 묶음 · 이름 · 단위 · 범위 · 설명 */
export interface ParamField {
  key: ParamKey
  label: string
  unit: string
  min: number
  max: number
  hint: string
}

export const PARAM_GROUPS: { title: string; fields: ParamField[] }[] = [
  {
    title: '꺼짐 (깜박임·검은 화면)',
    fields: [
      { key: 'blinkMaxS', label: '깜박임 최대 길이', unit: '초', min: 0.1, max: 60, hint: '이보다 오래 꺼져 있으면 검은 화면, 안에 다시 켜지면 깜박임' },
      { key: 'rampS', label: '급격히 꺼지는 시간', unit: '초', min: 0.03, max: 5, hint: '밝기가 이 시간 안에 떨어지면 급격히 꺼짐(깜박임), 더 걸리면 서서히(화면 페이드 — 짧게 꺼졌다 켜져도 깜박임 아님)' },
      { key: 'dropPct', label: '떨어진 정도', unit: '%', min: 1, max: 100, hint: '급격히 꺼짐: 꺼지기 전 가장 밝은 값의 이 비율 넘게 떨어짐' },
      { key: 'dropAbs', label: '떨어진 정도 최소', unit: '밝기 단계', min: 1, max: 255, hint: '급격히 꺼짐: 밝기(0~255)가 이 단계 넘게 떨어짐' },
      { key: 'offAbs', label: '꺼진 수준', unit: '밝기 단계', min: 0, max: 255, hint: '기준 밝기(영상에서 가장 어두웠던 밝기)와의 차이가 이 값 이하면 꺼진 밝기 (아래 비율과 큰 쪽)' },
      { key: 'offOnPct', label: '꺼진 수준 (켜진 밝기 대비)', unit: '%', min: 0, max: 100, hint: '켜진 평소 차이의 이 비율 이하도 꺼진 밝기 (꺼진 패널의 반사광 여유)' },
      { key: 'edgeOffPct', label: '윤곽 줄어듦', unit: '%', min: 1, max: 100, hint: '꺼진 동안 윤곽이 꺼지기 전 윤곽의 이 비율 이하 (어두운 테마·로고 화면은 윤곽이 남아 꺼짐 아님)' },
      { key: 'satMax', label: '색 없음', unit: '채도', min: 0, max: 255, hint: '평균 색의 채도(RGB 최대−최소)가 이 값보다 크면 어두워도 켜진 화면' },
      { key: 'blinkGroupS', label: '깜박임 묶음', unit: '초', min: 0.1, max: 60, hint: '첫 깜박임부터 이 시간 안에 이어지는 깜박임은 한 건으로 묶음' },
    ],
  },
  {
    title: '정지 · 화면 전환',
    fields: [
      { key: 'staticS', label: '정지 기준', unit: '초', min: 1, max: 86400, hint: '화면 변화가 이 시간 이상 없으면 정지 구간 (새 분석의 처음 값 — 분석마다 바꿀 수 있음)' },
      { key: 'transitionX', label: '화면 전환 민감도', unit: '배', min: 1, max: 100, hint: '프레임 차이가 평소 변화의 이 배 넘게 튀면 화면 전환 (작을수록 민감)' },
      { key: 'transitionMin', label: '화면 전환 최소 변화', unit: '밝기 단계', min: 0.5, max: 255, hint: '평소 변화가 아주 작아도 프레임 차이가 이 값은 넘어야 화면 전환' },
      { key: 'transitionMergeS', label: '화면 전환 합치기', unit: '초', min: 0, max: 10, hint: '이 간격 안에 이어진 큰 변화는 전환 한 건 (애니메이션이 여러 프레임에 걸침)' },
    ],
  },
  {
    title: 'Cycle 비교',
    fields: [
      { key: 'cycleDiff', label: '화면 밝기 차이', unit: '밝기 단계', min: 5, max: 200, hint: '기준 Cycle과 밝기가 이만큼 넘게 다르면 화면 다름 (평균 색은 1.5배). 새 분석의 처음 값' },
      { key: 'delayS', label: '지연 기준', unit: '초', min: 0.1, max: 30, hint: '화면 전환이 기준 Cycle보다 이만큼 넘게 늦으면 지연 (장치 응답 사양). 새 분석의 처음 값' },
      { key: 'lateS', label: '늦은 반응 최대', unit: '초', min: 0.5, max: 600, hint: '기준보다 이만큼 넘게 늦은 화면 전환은 짝짓지 않고 반응 없음으로' },
      { key: 'earlyS', label: '이른 반응 최대', unit: '초', min: 0, max: 60, hint: '기준보다 이만큼 넘게 이른 화면 전환은 짝짓지 않음' },
      { key: 'eventTolS', label: '꺼짐 짝 허용', unit: '초', min: 0.1, max: 60, hint: '같은 스텝에서 시점이 이 안이면 기준 Cycle과 같은 깜박임·검은 화면' },
      { key: 'offDurAbsS', label: '꺼짐 길이 차이', unit: '초', min: 0, max: 600, hint: '꺼진 길이가 기준과 이만큼 넘게, 그리고 아래 비율 넘게 다르면 길어짐·짧아짐' },
      { key: 'offDurPct', label: '꺼짐 길이 차이 (%)', unit: '%', min: 0, max: 1000, hint: '기준 길이의 이 비율 넘게 다를 때만' },
      { key: 'screenMinS', label: '화면 차이 최소 길이', unit: '초', min: 0.2, max: 60, hint: '화면 다름·깨짐은 이만큼 이어진 곳만 (0.2초 단위)' },
      { key: 'cellDiff', label: '칸 차이 (화면 깨짐)', unit: '밝기 단계', min: 1, max: 255, hint: '16×9 칸마다 기준과 밝기를 맞춘 뒤 이 값 넘게 다르면 다른 칸' },
      { key: 'corruptCells', label: '화면 깨짐 최소 칸', unit: '칸', min: 1, max: 72, hint: '다른 칸이 이만큼 이상이면 화면 깨짐 (절반 넘으면 화면 다름)' },
    ],
  },
]

/** 저장된 값 → 기준값 (모르는 이름·범위 밖 값은 버림) */
export function mergeParams(values: Record<string, number> | null | undefined): DetectParams {
  const out = { ...DETECT_DEFAULTS }
  if (!values) return out
  for (const group of PARAM_GROUPS) {
    for (const f of group.fields) {
      const v = values[f.key]
      if (typeof v === 'number' && Number.isFinite(v) && v >= f.min && v <= f.max) out[f.key] = v
    }
  }
  return out
}

/** 기준값 → 저장할 값 (기본값과 다른 것만) */
export function changedParams(p: DetectParams): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of Object.keys(DETECT_DEFAULTS) as ParamKey[]) if (p[k] !== DETECT_DEFAULTS[k]) out[k] = p[k]
  return out
}

/** 지금 프로젝트의 기준값: 처음에 서버에서 읽고(실패하면 기본값), save로 바꾼다. loaded: 서버에서 읽었거나 읽기에 실패함 (프로젝트를 모르면 바로) */
export function useProjectParams(projectId: string | null = currentProject()) {
  const [got, setGot] = useState<{ projectId: string; view: AnalysisDefaultsView | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    api.analysisDefaults(projectId).then(
      (view) => {
        if (!cancelled) setGot({ projectId, view, error: null })
      },
      (err: unknown) => {
        if (!cancelled) setGot({ projectId, view: null, error: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [projectId])
  const mine = got?.projectId === projectId ? got : null
  const view = mine?.view ?? null
  const save = useCallback(async (p: DetectParams) => {
    if (!projectId) throw new Error('로그인한 프로젝트를 몰라 저장할 수 없습니다')
    const saved = await api.saveAnalysisDefaults(projectId, changedParams(p))
    setGot({ projectId, view: saved, error: null })
  }, [projectId])
  const params = useMemo(() => mergeParams(view?.values), [view])
  return { params, view, loaded: !projectId || mine !== null, error: mine?.error ?? null, save, projectId }
}

export type ProjectParams = ReturnType<typeof useProjectParams>

/** 폼을 새로 그릴 열쇠: 서버에서 다 읽었거나 저장해 값이 바뀌면 칸을 그 값으로 (고치던 글은 버린다) */
export const formKey = (project: ProjectParams) => (project.loaded ? project.view?.updatedAt ?? 'loaded' : 'loading')
