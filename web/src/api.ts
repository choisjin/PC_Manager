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
export type TransferKind = 'Collect' | 'Fetch' | 'Push' | 'Compress' | 'Extract'
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
  /** 이 전송을 실행한 사용자 id */
  startedByUserId?: string | null
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
  /** 숨김 속성 (이전 에이전트는 보내지 않음 → 보통 파일로 취급) */
  hidden?: boolean
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
  /** 압축 파일 안을 보고 있으면 그 압축 파일 경로 (읽기 전용) */
  archivePath?: string | null
}

/** 텍스트 보기/편집: 서버가 인코딩·줄바꿈을 판별해 준다 (저장할 때 그대로 되돌림) */
export interface TextFile {
  /** 줄바꿈을 \n으로 맞춘 내용 */
  content: string
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'cp949'
  newline: '\r\n' | '\n'
  hash: string
  size: number
}

export interface SaveTextResult {
  success: boolean
  /** 편집하는 동안 다른 곳에서 파일이 바뀌어 저장하지 않음 */
  conflict: boolean
  error: string | null
  hash: string | null
}

/** 편집 폴더 현황. path가 null이면 로그인한 사용자가 없음 */
export interface EditFolderInfo {
  path: string | null
  files: number
  bytes: number
  /** 아직 원래 PC로 못 보낸 변경이 있는 사본 수 */
  pending: number
}

export interface EditCleanResult {
  deleted: number
  bytes: number
  /** 프로그램이 열고 있어 남긴 수 */
  inUse: number
  /** 못 보낸 변경이 있어 남긴 수 */
  pending: number
  info: EditFolderInfo
}

/** listing.error / 오류 문구가 이것으로 시작하면 압축 암호를 묻는다 */
export const ARCHIVE_PASSWORD_PREFIX = '암호가 필요합니다'

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

/** 서버가 직접 접근하는 공유 폴더 */
export interface SharedFolder {
  id: string
  name: string
  path: string
  username?: string | null
  /** 등록한 사용자. 없으면 예전에 등록된 공용 공유 폴더 */
  ownerUserId?: string | null
}

export interface SharedFolders {
  shares: SharedFolder[]
}

export interface Project {
  id: string
  name: string
}

export interface OrgUser {
  id: string
  name: string
}

export interface Org {
  projects: Project[]
  users: OrgUser[]
  /** projectId → 할당된 userId 목록 */
  projectUsers: Record<string, string[]>
  /** agentId → projectId (없으면 미배정) */
  agentProjects: Record<string, string>
  /** PC 목록 폴더 id → projectId. 배정된 폴더는 그 프로젝트 사용자에게만 보인다 */
  folderProjects?: Record<string, string>
}

/** 사용자가 수동으로 지정하는 PC 상태 */
export type PcStatusValue = 'available' | 'testing' | 'forbidden' | 'maintenance'

export const PC_STATUS_LABEL: Record<PcStatusValue, string> = {
  available: '사용 가능',
  testing: '테스트 중',
  forbidden: '사용 금지',
  maintenance: '점검 중',
}

export interface PcStatus {
  agentId: string
  status: PcStatusValue
  note: string | null
  setByUserId: string | null
  setAt: string
}

export interface PcStatuses {
  statuses: Record<string, PcStatus>
}

export interface RemoteUsage {
  /** agentId → 원격조작 중인 사용자 */
  inUseBy: Record<string, { userId: string; since: string }>
}

export interface ChatMessage {
  id: number
  userId: string
  text: string
  at: string
  /** @로 호출한 userId 목록 */
  mentions?: string[]
  /** 읽음 처리한 userId 목록 */
  readBy?: string[]
}

/** Remote 화면용 PC 미리보기 */
export interface Thumbnail {
  agentId: string
  /** base64 JPEG */
  jpeg: string
  /** 시계를 뺀 화면이 바뀌지 않은 시간(초) */
  idleSeconds: number
  at: string
}

export interface InstallInfo {
  serverUrl: string
  serverVersion: string
  /** 서버에 더블클릭 설치 파일이 있으면 true */
  setupAvailable: boolean
  setupDownloadUrl: string
  /** 대시보드 HTTPS 주소 (원격조작 키보드 잠금·WebCodecs용). 설치형이 아니면 null */
  httpsUrl: string | null
  /** 자체 서명 인증서(.cer) 다운로드 경로. 없으면 null */
  certificateDownloadUrl: string | null
  /** 대시보드 PC용 인증서 신뢰 설치 도구(.cmd) 경로. 없으면 null */
  certificateInstallerUrl: string | null
  /** 서버가 도는 PC의 머신 이름 (Remote 모드에서 '내 PC'를 숨기는 데 쓴다) */
  serverMachineName: string | null
  /** 대시보드를 연 이 PC의 IP. 이 IP를 가진 에이전트도 Remote 모드에서 숨긴다. 서버 PC에서 열면 null */
  clientIp: string | null
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

// 현재 로그인(선택)한 사용자 id. 전송 기록에 "누가 실행했는지" 남기기 위해 헤더로 보낸다.
let currentUserId: string | null = null
export function setCurrentUser(userId: string | null) {
  currentUserId = userId
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(currentUserId ? { 'X-User-Id': currentUserId } : {}),
      ...init?.headers,
    },
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

  shares: () => request<SharedFolders>('/api/shares'),
  addShare: (name: string, path: string, username?: string, password?: string) =>
    request<SharedFolder>('/api/shares', {
      method: 'POST',
      body: JSON.stringify({ name, path, username: username || null, password: password || null }),
    }),
  removeShare: (id: string) => request<SharedFolders>(`/api/shares/${id}`, { method: 'DELETE' }),
  renameShare: (id: string, name: string) =>
    request<SharedFolder>(`/api/shares/${id}/name`, { method: 'PUT', body: JSON.stringify({ name }) }),

  /** 파일에 대한 공개 다운로드 링크 생성 (토큰만 있으면 누구나 받음) */
  createDownloadLink: (agentId: string, path: string) =>
    request<{ token: string; url: string; name: string }>(`/api/agents/${agentId}/download-links`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  org: () => request<Org>('/api/org'),
  createProject: (name: string) => request<Org>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  renameProject: (id: string, name: string) => request<Org>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteProject: (id: string) => request<Org>(`/api/projects/${id}`, { method: 'DELETE' }),
  setProjectUsers: (id: string, userIds: string[]) => request<Org>(`/api/projects/${id}/users`, { method: 'PUT', body: JSON.stringify({ userIds }) }),
  createUser: (name: string) => request<Org>('/api/users', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteUser: (id: string) => request<Org>(`/api/users/${id}`, { method: 'DELETE' }),
  setAgentProject: (agentId: string, projectId: string | null) =>
    request<Org>(`/api/agents/${agentId}/project`, { method: 'PUT', body: JSON.stringify({ projectId }) }),
  setFolderProject: (folderId: string, projectId: string | null) =>
    request<Org>(`/api/folders/${folderId}/project`, { method: 'PUT', body: JSON.stringify({ projectId }) }),

  pcStatuses: () => request<PcStatuses>('/api/pc-status'),
  setPcStatus: (agentId: string, status: PcStatusValue, note: string | null) =>
    request<PcStatuses>(`/api/agents/${agentId}/status`, { method: 'PUT', body: JSON.stringify({ status, note }) }),
  remoteUsage: () => request<RemoteUsage>('/api/remote-usage'),
  chat: (take = 100) => request<ChatMessage[]>(`/api/chat?take=${take}`),

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

  /** 원격조작 화면/입력 WebSocket 주소 (사용자 id는 '사용 중' 표시·차단에 쓴다) */
  remoteUrl: (agentId: string, userId: string | null) =>
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/agents/${agentId}/remote${userId ? `?user=${encodeURIComponent(userId)}` : ''}`,
  /** Ctrl+Alt+Del 보내기 (에이전트 서비스가 SAS 전송) */
  sendCtrlAltDel: (agentId: string) => request<void>(`/api/agents/${agentId}/remote/cad`, { method: 'POST' }),

  /** 파일을 브라우저 다운로드 폴더로 바로 내려받는 URL (첨부) */
  downloadUrl: (agentId: string, path: string) =>
    `/api/agents/${agentId}/download?${query({ path })}`,

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

  /** PC 안에서 선택 항목을 ZIP으로 압축 (PC에서 직접 수행). splitBytes>0이면 분할 압축. 진행 상황은 전송 기록에 표시된다 */
  readText: (agentId: string, path: string) => request<TextFile>(`/api/agents/${agentId}/text?${query({ path })}`),
  saveText: (agentId: string, body: { path: string; content: string; encoding: string; newline: string; baseHash: string | null; backup: boolean }) =>
    request<SaveTextResult>(`/api/agents/${agentId}/text`, { method: 'PUT', body: JSON.stringify(body) }),
  /** 편집 중인 내용을 원래 인코딩의 바이트로 (내 PC에 저장용) */
  encodeText: async (content: string, encoding: string, newline: string) => {
    const res = await fetch('/api/text/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, encoding, newline }),
    })
    if (!res.ok) throw new Error(errorMessage(res.status, await res.text()))
    return res.blob()
  },
  /** 내 PC 프로그램으로 열기: editorAgentId(대시보드를 연 PC의 에이전트)로 보내 열고, 저장하면 원래 경로로 되돌린다 */
  openLocal: (agentId: string, path: string, editorAgentId: string, label: string, readOnly: boolean, backup: boolean) =>
    request<void>(`/api/agents/${agentId}/open-local`, {
      method: 'POST',
      body: JSON.stringify({ path, editorAgentId, label, readOnly, backup }),
    }),
  /** 편집 폴더(대시보드를 연 PC의 문서\\PC Manager 편집): 현황 / 탐색기로 열기 / 정리 */
  editFolderInfo: (agentId: string) => request<EditFolderInfo>(`/api/agents/${agentId}/edit-folder`),
  openEditFolder: (agentId: string) => request<void>(`/api/agents/${agentId}/edit-folder/open`, { method: 'POST' }),
  cleanEditFolder: (agentId: string) => request<EditCleanResult>(`/api/agents/${agentId}/edit-folder/clean`, { method: 'POST' }),
  /** 압축 풀기 (같은 PC). entryPaths가 비면 전부 */
  extractFiles: (agentId: string, archivePath: string, entryPaths: string[], destinationFolder: string) =>
    request<Transfer>(`/api/agents/${agentId}/files/extract`, {
      method: 'POST',
      body: JSON.stringify({ archivePath, entryPaths, destinationFolder }),
    }),
  setArchivePassword: (agentId: string, archivePath: string, password: string) =>
    request<void>(`/api/agents/${agentId}/archive-password`, { method: 'POST', body: JSON.stringify({ archivePath, password }) }),
  compressFiles: (agentId: string, paths: string[], destinationFolder: string, archiveName?: string, splitBytes = 0) =>
    request<Transfer>(`/api/agents/${agentId}/files/compress`, {
      method: 'POST',
      body: JSON.stringify({ paths, destinationFolder, archiveName: archiveName ?? null, splitBytes }),
    }),
}
