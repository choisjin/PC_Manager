export type ShellKind = 'Cmd' | 'PowerShell'
export type RunState = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'TimedOut' | 'Cancelled'
export type OutputStream = 'StdOut' | 'StdErr' | 'System'

export interface Agent {
  id: string
  machineName: string
  osVersion: string
  agentVersion: string
  userName: string
  ipAddresses: string[]
  macAddresses: string[]
  tags: string[]
  online: boolean
  firstSeenAt: string
  lastSeenAt: string
}

export interface Run {
  id: string
  agentId: string
  /** Job 단계로 실행된 경우 */
  jobRunId: string | null
  stepIndex: number | null
  shell: ShellKind
  commandLine: string
  workingDirectory: string | null
  timeoutSeconds: number
  state: RunState
  exitCode: number | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface OutputLine {
  runId: string
  seq: number
  stream: OutputStream
  text: string
  timestamp: string
}

export interface CreateRunsRequest {
  agentIds: string[]
  shell: ShellKind
  commandLine: string
  workingDirectory: string | null
  timeoutSeconds: number
  encoding: string | null
}

export type JobState = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Cancelled'
export type JobStepKind = 'Command' | 'Collect'
export type TransferKind = 'Collect' | 'Fetch' | 'Push'
export type TransferState = 'Pending' | 'Succeeded' | 'Failed'

export interface JobStep {
  kind: JobStepKind
  name: string | null
  shell: ShellKind
  commandLine: string | null
  workingDirectory: string | null
  timeoutSeconds: number
  encoding: string | null
  /** 비우면 PCM_RESULT_DIR */
  sourceDirectory: string | null
  patterns: string[]
  continueOnError: boolean
}

export interface JobRun {
  id: string
  name: string
  steps: JobStep[]
  maxParallel: number
  state: JobState
  createdAt: string
  finishedAt: string | null
}

export interface JobTarget {
  jobRunId: string
  agentId: string
  state: JobState
  currentStep: number
  error: string | null
  testsTotal: number | null
  testsFailed: number | null
  testsSkipped: number | null
  startedAt: string | null
  finishedAt: string | null
}

export interface JobRunDetail {
  job: JobRun
  targets: JobTarget[]
}

export interface CreateJobRequest {
  name: string | null
  agentIds: string[]
  tags: string[]
  steps: JobStep[]
  maxParallel: number
}

export interface Transfer {
  id: string
  agentId: string
  kind: TransferKind
  jobRunId: string | null
  stepIndex: number | null
  path: string | null
  state: TransferState
  fileCount: number
  totalBytes: number
  error: string | null
  createdAt: string
  finishedAt: string | null
}

export interface Artifact {
  id: string
  transferId: string
  agentId: string
  jobRunId: string | null
  relativePath: string
  size: number
  createdAt: string
  testsTotal: number | null
  testsFailed: number | null
  testsSkipped: number | null
}

export interface FileEntry {
  name: string
  fullPath: string
  isDirectory: boolean
  size: number
  modifiedAt: string | null
}

export interface DirectoryListing {
  /** 빈 문자열이면 드라이브 목록 */
  path: string
  parentPath: string | null
  entries: FileEntry[]
  error: string | null
}

export interface InstallInfo {
  serverUrl: string
  serverVersion: string
  /** 서버에 더블클릭 설치 파일이 있으면 true */
  setupAvailable: boolean
  setupDownloadUrl: string
}

export const isActiveRun = (state: RunState) => state === 'Pending' || state === 'Running'
export const isActiveJob = (state: JobState) => state === 'Pending' || state === 'Running'

/** 서버 오류 응답(문자열 또는 ProblemDetails)에서 사람이 읽을 메시지를 꺼낸다 */
function errorMessage(status: number, body: string) {
  if (!body) return `요청 실패 (${status})`
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'string') return parsed
    if (parsed && typeof parsed === 'object') {
      const problem = parsed as { detail?: string; title?: string }
      if (problem.detail || problem.title) return (problem.detail ?? problem.title)!
    }
  } catch {
    // JSON이 아닌 응답
  }
  return body
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new Error(errorMessage(res.status, await res.text()))
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const query = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString()

export const api = {
  agents: () => request<Agent[]>('/api/agents'),
  runs: () => request<Run[]>('/api/runs?take=200'),
  output: (runId: string, afterSeq = 0) =>
    request<OutputLine[]>(`/api/runs/${runId}/output?afterSeq=${afterSeq}`),
  createRuns: (body: CreateRunsRequest) =>
    request<Run[]>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  cancelRun: (runId: string) => request<void>(`/api/runs/${runId}/cancel`, { method: 'POST' }),

  jobs: () => request<JobRun[]>('/api/jobs?take=100'),
  job: (jobRunId: string) => request<JobRunDetail>(`/api/jobs/${jobRunId}`),
  jobRuns: (jobRunId: string) => request<Run[]>(`/api/runs?${query({ jobRunId, take: 500 })}`),
  createJob: (body: CreateJobRequest) =>
    request<JobRunDetail>('/api/jobs', { method: 'POST', body: JSON.stringify(body) }),
  cancelJob: (jobRunId: string) => request<void>(`/api/jobs/${jobRunId}/cancel`, { method: 'POST' }),

  artifacts: (filter: { jobRunId?: string; transferId?: string; agentId?: string }) =>
    request<Artifact[]>(`/api/artifacts?${query(filter)}`),
  artifactUrl: (artifactId: string, inline = false) =>
    `/api/artifacts/${artifactId}/download${inline ? '?inline=true' : ''}`,
  transfers: (filter: { agentId?: string; jobRunId?: string }) =>
    request<Transfer[]>(`/api/transfers?${query({ ...filter, take: 100 })}`),

  installInfo: () => request<InstallInfo>('/api/install/info'),

  listFiles: (agentId: string, path: string) =>
    request<DirectoryListing>(`/api/agents/${agentId}/files?${query({ path })}`),
  fetchFile: (agentId: string, path: string) =>
    request<Transfer>(`/api/agents/${agentId}/files/fetch`, { method: 'POST', body: JSON.stringify({ path }) }),
  pushFile: (agentId: string, destinationPath: string, file: Blob) =>
    request<Transfer>(`/api/agents/${agentId}/files/push?${query({ path: destinationPath })}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
}
