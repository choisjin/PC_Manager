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
export type TransferKind = 'Collect' | 'Fetch' | 'Push' | 'Compress'
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
  /** 진행률(0-100). 압축·PC 간 전송 중에만 채워진다 */
  percent?: number | null
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

export type FileOpKind = 'Copy' | 'Move' | 'Delete' | 'CreateDirectory' | 'Rename'

export interface FileOpResult {
  success: boolean
  error: string | null
  resultPath: string | null
}

export interface DirectoryListing {
  /** 빈 문자열이면 드라이브 목록 */
  path: string
  parentPath: string | null
  entries: FileEntry[]
  error: string | null
}

export type UpdatePhase = 'Idle' | 'Downloading' | 'Installing' | 'Restarting' | 'Failed'

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  releaseName: string | null
  releaseNotes: string | null
  releaseUrl: string | null
  publishedAt: string | null
  checkedAt: string | null
  checkError: string | null
  serverAssetAvailable: boolean
  serverPhase: UpdatePhase
  serverError: string | null
}

export interface AgentUpdateResult {
  requested: number
  dispatched: number
  error: string | null
}

export interface PcGroupFolder {
  id: string
  name: string
  parentId: string | null
  order: number
}

export interface PcGroups {
  folders: PcGroupFolder[]
  /** agentId → folderId. 없는 PC는 미분류 */
  assignments: Record<string, string>
  /** agentId → 별칭(표시 이름) */
  aliases?: Record<string, string>
}

export interface PcFavorites {
  /** agentId → 즐겨찾기 폴더 경로 목록 */
  favorites: Record<string, string[]>
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
  run: (runId: string) => request<Run>(`/api/runs/${runId}`),
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

  pcGroups: () => request<PcGroups>('/api/pc-groups'),
  savePcGroups: (groups: PcGroups) =>
    request<PcGroups>('/api/pc-groups', { method: 'PUT', body: JSON.stringify(groups) }),

  pcFavorites: () => request<PcFavorites>('/api/pc-favorites'),
  savePcFavorites: (favorites: PcFavorites) =>
    request<PcFavorites>('/api/pc-favorites', { method: 'PUT', body: JSON.stringify(favorites) }),

  updateStatus: () => request<UpdateStatus>('/api/update'),
  checkUpdate: () => request<UpdateStatus>('/api/update/check', { method: 'POST' }),
  updateServer: () => request<void>('/api/update/server', { method: 'POST' }),
  updateAgents: (agentIds?: string[]) =>
    request<AgentUpdateResult>('/api/update/agents', {
      method: 'POST',
      body: JSON.stringify({ agentIds: agentIds ?? null }),
    }),

  listFiles: (agentId: string, path: string) =>
    request<DirectoryListing>(`/api/agents/${agentId}/files?${query({ path })}`),
  /** 원격 PC의 미디어 파일을 서버로 옮기지 않고 바로 스트리밍하는 URL (video 태그 src용) */
  mediaUrl: (agentId: string, path: string) =>
    `/api/agents/${agentId}/media?${query({ path })}`,

  fetchFile: (agentId: string, path: string) =>
    request<Transfer>(`/api/agents/${agentId}/files/fetch`, { method: 'POST', body: JSON.stringify({ path }) }),
  pushFile: (agentId: string, destinationPath: string, file: Blob) =>
    request<Transfer>(`/api/agents/${agentId}/files/push?${query({ path: destinationPath })}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
    }),

  /** 같은 PC 안의 파일 조작 (복사/이동/삭제/폴더 생성/이름 변경) */
  fileOp: (agentId: string, op: FileOpKind, path: string, target?: string) =>
    request<FileOpResult>(`/api/agents/${agentId}/files/op`, {
      method: 'POST',
      body: JSON.stringify({ op, path, target: target ?? null }),
    }),

  /** PC 간 파일 붙여넣기 (원본 → 서버 중계 → 대상, 서버 디스크 미경유, 단일 파일) */
  crossCopy: (body: { sourceAgentId: string; sourcePath: string; destAgentId: string; destFolder: string; move: boolean }) =>
    request<FileOpResult>('/api/files/cross-copy', { method: 'POST', body: JSON.stringify(body) }),

  /** PC 안에서 선택 항목을 ZIP으로 압축 (PC에서 직접 수행). 진행 상황은 전송 기록에 표시된다 */
  compressFiles: (agentId: string, paths: string[], destinationFolder: string, archiveName?: string) =>
    request<Transfer>(`/api/agents/${agentId}/files/compress`, {
      method: 'POST',
      body: JSON.stringify({ paths, destinationFolder, archiveName: archiveName ?? null }),
    }),
}
