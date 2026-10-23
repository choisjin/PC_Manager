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
  /** 하위 폴더 검색에서 결과가 많거나 오래 걸려 일부만 */
  truncated?: boolean
}

/** State 화면 배치 (모든 사용자 공유). 위치는 화면 영역 비율 0~1 */
export interface StateLayout {
  positions: Record<string, { x: number; y: number }>
  locked: boolean
  updatedBy: string | null
  updatedAt: string | null
}

export type ArchiveFormat = 'zip' | '7z' | 'tar' | 'tar.gz'
export const ARCHIVE_FORMATS: { value: ArchiveFormat; label: string }[] = [
  { value: 'zip', label: 'ZIP (.zip)' },
  { value: '7z', label: '7z (.7z)' },
  { value: 'tar', label: 'TAR (.tar)' },
  { value: 'tar.gz', label: 'TAR.GZ (.tar.gz)' },
]

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

/** 파일 즐겨찾기 하나 (사용자별). 어느 PC·공유 폴더의 파일인지 늘 함께 둔다 */
export interface FileFavorite {
  id: string
  /** 에이전트 id 또는 공유 폴더 id */
  sourceId: string
  /** 추가할 때의 PC 이름(별칭)·공유 폴더 이름 */
  sourceName: string
  /** 공유 폴더 파일: 내 PC에서 네트워크 경로로 바로 연다. 아니면 내 PC 프로그램으로 열기(저장하면 원래 PC에) */
  isShare: boolean
  path: string
  addedAt: string
}

export interface FileFavorites {
  items: FileFavorite[]
}

export interface FileFavoriteAccess {
  ok: boolean
  reason: string | null
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
  createdAt?: string | null
}

export interface OrgUser {
  id: string
  name: string
  /** 'admin' = 프로젝트 관리자 (그 프로젝트만), 그 외 = LG 계정 사용자 */
  role?: string | null
  /** 관리자 계정이 묶인 프로젝트 */
  projectId?: string | null
  ldapId?: string | null
  title?: string | null
  team?: string | null
  department?: string | null
  email?: string | null
  lastLogin?: string | null
}

export interface Org {
  projects: Project[]
  users: OrgUser[]
  /** projectId → 멤버 userId (관리자 + 그 프로젝트 기능이 하나라도 있는 사용자) */
  projectUsers: Record<string, string[]>
  /** agentId → projectId (없으면 미배정) */
  agentProjects: Record<string, string>
  /** PC 목록 폴더 id → projectId. 배정된 폴더는 그 프로젝트 사용자에게만 보인다 */
  folderProjects?: Record<string, string>
  /** projectId → (userId → 쓸 수 있는 기능 id) */
  projectPerms?: Record<string, Record<string, string[]>>
  /** projectId → 관리자가 권한을 조정한 userId (조정 전 = 미분류) */
  permReviewed?: Record<string, string[]>
}

/** 로그인 결과 (remember: 자동 로그인 토큰, 체크했을 때만) */
export interface LoginResult {
  token: string
  user: OrgUser
  project: Project
  perms: string[]
  remember?: string | null
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

/** 채팅방 메시지. userId가 null이면 시스템 안내(초대·강퇴·나가기 등) */
/** PIN으로 잠긴 PC */
export interface PcLock {
  agentId: string
  /** 잠근 사람 */
  ownerUserId: string | null
  lockedAt: string
  /** 이 브라우저가 PIN을 넣어 풀었는지 (12시간) */
  unlocked: boolean
}

/** 메모: shared(공유, 누구나 보고 고침) | personal(개인, 나만) */
export interface Note {
  id: string
  scope: 'shared' | 'personal'
  ownerId: string
  /** 목록 제목 (내용 첫 줄) */
  title: string
  /** 정리된 HTML (글자·줄바꿈·목록·이미지) */
  content: string
  createdAt: string
  updatedAt: string
  updatedBy: string
}

/** 메모 저장 결과: 그 사이 다른 곳에서 고쳤으면 conflict에 최신 메모 */
export type NoteSaveResult = { note: Note; conflict?: undefined } | { note?: undefined; conflict: Note }

export interface ChatMessage {
  id: number
  roomId: string
  userId: string | null
  text: string
  at: string
  /** @로 호출한 userId 목록 */
  mentions?: string[] | null
}

/** 채팅방: direct(1:1) | group */
export interface ChatRoom {
  id: string
  /** all: 모든 사용자가 들어 있는 기본 전체 방 (나가기·초대 없음) */
  kind: 'direct' | 'group' | 'all'
  /** 그룹·전체 방 이름 (1:1은 null → 상대 이름으로 표시) */
  name: string | null
  /** 그룹 방장 (강퇴 가능) */
  ownerId: string | null
  members: { userId: string; joinedAt: string }[]
  createdAt: string
  /** 사용자별 마지막으로 읽은 메시지 번호 */
  reads: Record<string, number>
  lastMessage: ChatMessage | null
  /** 내가 안 읽은 메시지 수 */
  unread: number
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

// ── 결과 확인 도구 (Result·영상·이미지 맞춰 보기)
/** 영상 재생 준비 결과. playPath: 재생할 파일 (원본 또는 탐색 가능한 사본, 변환 전이면 null) */
export interface VideoPrepareResult {
  playPath: string | null
  needsConvert: boolean
  duration: number | null
  fps: number | null
  /** 변환이 무엇을 하는지 */
  note: string | null
  error: string | null
  /** 왜 바로 재생할 수 없는지 (옛 에이전트는 없음) */
  reason?: string | null
  /** 다시 인코딩 (오래 걸림). false면 영상은 그대로 옮겨 담기만 */
  transcode?: boolean
  /** 원본 크기 (사본도 대략 이만큼) · 사본을 둘 드라이브와 그 남은 공간 */
  sourceBytes?: number
  cacheDrive?: string | null
  cacheFreeBytes?: number
}

export interface DriveSpace {
  name: string
  label: string | null
  freeBytes: number
  totalBytes: number
}

export interface VideoCacheEntry {
  /** 재생용 사본 폴더 안 파일 이름 (지울 때) */
  name: string
  bytes: number
  /** 마지막으로 쓴 시각 (UTC ISO) */
  lastUsed: string
  /** 원본 영상 경로 (모르면 null) */
  source: string | null
  converting: boolean
}

export interface VideoStorageInfo {
  drives: DriveSpace[]
  cacheDirectory: string
  cache: VideoCacheEntry[]
}

/** 재생 준비 진행. stage: ffmpeg = 테스트 PC가 ffmpeg 받는 중 · convert = 재생용 사본 만드는 중. bytes: 받은·처리한 원본 바이트 */
export interface VideoPrepareProgress {
  stage: 'ffmpeg' | 'convert'
  fraction: number
  bytes: number
  totalBytes: number
  elapsedSeconds: number
}

/** 이미지 찾기 요청: 좌표는 frameWidth×frameHeight(크롭한 영상 원래 크기) 픽셀, template은 회색조 픽셀 base64 */
export interface ImageSearchRequest {
  paths: string[]
  frameWidth: number
  frameHeight: number
  templateWidth: number
  templateHeight: number
  template: string
  searchX: number
  searchY: number
  searchWidth: number
  searchHeight: number
  /** 이 구간들만 훑는다 (paths의 video번째 영상 start~end초). 없으면 영상 전체 */
  ranges?: { video: number; start: number; end: number }[]
}

export interface ImageSearchVideo {
  path: string
  /** scores 한 칸 간격 (프레임 i = i/fps초) */
  fps: number
  /** 프레임별 유사도 0~200 (= 0~100%) base64 */
  scores: string
  error: string | null
}

export interface ImageSearchStatus {
  state: 'running' | 'done' | 'failed' | 'canceled'
  progress: number
  current: string | null
  /** 끝난 영상 (요청한 have개 다음부터) */
  videos: ImageSearchVideo[]
  /** 넓은 영역을 줄여 훑은 배율 (1 = 원래 크기) */
  scale: number
  error: string | null
}

/** 이미지 찾기 결과 조각: video번째 영상의 offset 프레임부터 유사도 (훑는 중인 영상은 확정된 프레임까지) */
export interface ImageSearchChunk {
  video: number
  path: string
  fps: number
  offset: number
  /** 프레임별 유사도 0~200 base64 */
  scores: string
  /** 이 영상의 마지막 조각 */
  done: boolean
  error: string | null
}

export interface ImageSearchProgress {
  state: 'running' | 'done' | 'failed' | 'canceled'
  progress: number
  current: string | null
  scale: number
  error: string | null
  /** 요청한 위치부터 이어지는 결과 (한 번에 1MB까지) */
  chunks: ImageSearchChunk[]
  /** 더 받을 결과가 남았다 → 곧바로 다시 묻는다 */
  more: boolean
}

/** PC 정보 패널: 시스템·디스크 탭 */
export interface PcSystemInfo {
  platform: 'windows' | 'linux'
  machineName: string
  /** "Windows 11 Pro" · "Ubuntu 24.04.1 LTS" */
  os: string
  /** Windows 버전 ("24H2"), Linux는 null */
  osVersion: string | null
  /** Windows 빌드 · Linux 커널 */
  osBuild: string
  architecture: string
  manufacturer: string | null
  model: string | null
  bios: string | null
  cpu: string
  /** 물리 코어 (모르면 0) */
  cores: number
  logicalProcessors: number
  memoryBytes: number
  gpus: string[]
  /** UTC ISO */
  bootTime: string
  users: string[]
  drives: DriveDetail[]
}

export interface DriveDetail {
  name: string
  label: string | null
  type: 'fixed' | 'removable' | 'network' | 'cdrom' | 'other'
  format: string | null
  freeBytes: number
  totalBytes: number
}

/** cpu: PC 전체 대비 % · memory: 바이트 (Windows 개인 작업 집합) */
export interface ProcessEntry {
  id: number
  name: string
  cpu: number
  memory: number
}

/** 성능 1초 측정값. 사용률 %, 속도 초당 바이트 */
export interface PerfSample {
  seq: number
  cpu: number
  memoryUsed: number
  memoryTotal: number
  diskRead: number
  diskWrite: number
  /** 가장 바쁜 디스크의 활성 시간 % */
  diskActive: number
  netReceive: number
  netSend: number
  /** Windows만 (모르면 null) */
  gpu: number | null
}

export interface PerfHistory {
  /** 측정을 새로 시작하면 바뀐다 → 그래프를 새로 */
  session: string
  samples: PerfSample[]
}

/** 장치 관리자 한 줄. problem: 0 정상, 장치 관리자 문제 코드 (22 사용 안 함, 28 드라이버 없음 …) */
export interface DeviceEntry {
  class: string
  name: string
  manufacturer: string | null
  problem: number
  id: string | null
}

export interface ResultSetBackup {
  state: 'running' | 'done' | 'failed'
  filesDone: number
  filesTotal: number
  bytesDone: number
  error: string | null
  /** 테스트 PC에 없어 건너뛴 파일 (Result에 적힌 다른 PC 경로 등) */
  skipped: number
}

export interface ResultSetSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  createdBy: string | null
  agentId: string
  machineName: string | null
  resultPath: string
  videoCount: number
  copyVideo: boolean
  backup: ResultSetBackup
}

export interface ResultSet {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  createdBy: string | null
  agentId: string
  machineName: string | null
  resultPath: string
  videoPaths: string[]
  imageDir: string | null
  copyVideo: boolean
  /** 화면 설정 (열 지정·동기화 보정) — 형식은 결과 확인 화면이 정한다 */
  config: unknown
  requested: string[]
  /** 원래 경로 → 서버 백업 파일 */
  files: Record<string, string>
  backup: ResultSetBackup
}

/** 결과 확인 탭: PC별로 미리 정해 둔 결과 폴더 (모든 사용자 공용) */
export interface ResultProfile {
  mode: 'ats' | 'rfw'
  /** Result 파일(CSV)을 찾을 폴더 (ATS는 바로 안과 날짜 폴더 바로 안만, RFW는 하위 폴더까지) */
  resultDir: string
  /** Result 파일 이름 패턴 (비우면 *.csv) */
  pattern: string | null
  /** 영상 폴더 (하위 폴더까지) */
  videoDir: string | null
  /** 결과 이미지 폴더: 고정 폴더 또는 실행마다 날짜 폴더가 생기는 상위 폴더 */
  imageDir: string | null
  /** 원본 이미지 폴더 */
  refDir: string | null
  updatedBy?: string | null
  updatedAt?: string | null
}

/** 결과 폴더 프리셋: 이름 붙여 저장한 결과 폴더 묶음 (모든 사용자 공용). PC 설정에서 골라 바로 채운다 */
export interface ResultPreset {
  name: string
  mode: 'ats' | 'rfw'
  resultDir: string
  pattern: string | null
  videoDir: string | null
  imageDir: string | null
  refDir: string | null
  updatedBy?: string | null
  updatedAt?: string | null
}

export interface ResultProfiles {
  profiles: Record<string, ResultProfile>
  /** 프리셋 id → 프리셋 (처음엔 서버 기본 ATS·RFW) */
  presets?: Record<string, ResultPreset> | null
}

export interface CreateResultSet {
  name: string
  agentId: string
  machineName: string | null
  resultPath: string
  videoPaths: string[]
  imageDir: string | null
  copyVideo: boolean
  config: unknown
  /** Result·영상 외에 백업할 파일 (이미지) */
  files: string[]
}

/** Windows 에이전트의 OS 설명은 'Microsoft Windows …', Linux는 배포판 이름 (예: Ubuntu 24.04 LTS) */
export const isLinuxAgent = (agent: Agent) => !!agent.osVersion && !agent.osVersion.startsWith('Microsoft Windows')

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
  /** Linux 테스트 PC에서 실행할 설치 한 줄 (서버에 Linux 에이전트가 없으면 null) */
  linuxInstallCommand: string | null
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
      const problem = parsed as { detail?: string; title?: string; error?: string }
      if (problem.error) return problem.error
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

// PIN으로 잠긴 PC(423)를 만났을 때: PIN을 물어 풀면 true (pcLocks가 등록)
let lockedHandler: ((agentId: string) => Promise<boolean>) | null = null
export function setLockedHandler(handler: (agentId: string) => Promise<boolean>) {
  lockedHandler = handler
}

async function request<T>(url: string, init?: RequestInit, retried = false): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(currentUserId ? { 'X-User-Id': currentUserId } : {}),
      ...init?.headers,
    },
  })
  if (res.status === 423) {
    // 잠긴 PC: PIN을 넣어 풀면 한 번 다시 시도
    const body = await res.text()
    let agentId: string | undefined
    try {
      agentId = (JSON.parse(body) as { agentId?: string }).agentId
    } catch {
      // 무시
    }
    if (!retried && agentId && lockedHandler && (await lockedHandler(agentId))) return request<T>(url, init, true)
    throw new Error(errorMessage(res.status, body))
  }
  // status: 호출한 쪽이 404(없음)와 일시적인 실패를 가를 수 있게
  if (!res.ok) throw Object.assign(new Error(errorMessage(res.status, await res.text())), { status: res.status })
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
  removeAgent: (id: string) => request<void>(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
  stateLayout: () => request<StateLayout>('/api/state-layout'),
  saveStateLayout: (layout: StateLayout) => request<StateLayout>('/api/state-layout', { method: 'PUT', body: JSON.stringify(layout) }),
  savePcFavorites: (favorites: PcFavorites) =>
    request<PcFavorites>('/api/pc-favorites', { method: 'PUT', body: JSON.stringify(favorites) }),
  fileFavorites: () => request<FileFavorites>('/api/file-favorites'),
  saveFileFavorites: (items: FileFavorite[]) =>
    request<FileFavorites>('/api/file-favorites', { method: 'PUT', body: JSON.stringify({ items }) }),
  /** 즐겨찾기 id → 지금 열 수 있는지 */
  fileFavoriteAccess: () => request<Record<string, FileFavoriteAccess>>('/api/file-favorites/access', { method: 'POST' }),
  /** 공유 폴더 파일을 내 PC에서 네트워크 경로로 바로 연다 (사본 없음) */
  openShareDirect: (shareId: string, path: string, editorAgentId: string) =>
    request<void>(`/api/shares/${encodeURIComponent(shareId)}/open-direct`, { method: 'POST', body: JSON.stringify({ path, editorAgentId }) }),

  shares: () => request<SharedFolders>('/api/shares'),
  addShare: (name: string, path: string, username?: string, password?: string) =>
    request<SharedFolder>('/api/shares', {
      method: 'POST',
      body: JSON.stringify({ name, path, username: username || null, password: password || null }),
    }),
  removeShare: (id: string) => request<SharedFolders>(`/api/shares/${id}`, { method: 'DELETE' }),
  /** 등록 전 확인: 자격증명 없이 열리는지 */
  probeShare: (path: string) =>
    request<{ accessible: boolean; needsCredentials: boolean; error: string | null }>('/api/shares/probe', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  reorderShares: (ids: string[]) =>
    request<SharedFolders>('/api/shares/order', { method: 'PUT', body: JSON.stringify({ ids }) }),
  renameShare: (id: string, name: string) =>
    request<SharedFolder>(`/api/shares/${id}/name`, { method: 'PUT', body: JSON.stringify({ name }) }),

  /** 파일에 대한 공개 다운로드 링크 생성 (토큰만 있으면 누구나 받음) */
  createDownloadLink: (agentId: string, path: string) =>
    request<{ token: string; url: string; name: string }>(`/api/agents/${agentId}/download-links`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  org: () => request<Org>('/api/org'),
  login: (projectId: string, username: string, password: string, remember: boolean) =>
    request<LoginResult>('/api/auth/login', { method: 'POST', body: JSON.stringify({ projectId, username, password, remember }) }),
  autoLogin: (token: string) => request<LoginResult>('/api/auth/auto-login', { method: 'POST', body: JSON.stringify({ token }) }),
  /** APMS 안에 넣은 대시보드: APMS 포털이 준 1회용 표로 같은 계정 로그인 */
  apmsSso: (ticket: string, apmsOrigin: string) =>
    request<LoginResult>('/api/auth/apms-sso', { method: 'POST', body: JSON.stringify({ ticket, apmsOrigin }) }),
  me: (token: string) =>
    request<Omit<LoginResult, 'token' | 'remember'>>('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }),
  logout: (token: string | null, remember: string | null) =>
    request<void>('/api/auth/logout', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({ remember }),
    }),
  changeAdminPassword: (token: string, oldPassword: string, newPassword: string) =>
    request<void>('/api/auth/admin-password', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ old: oldPassword, new: newPassword }),
    }),
  /** 설정 '에이전트 서버 주소 일괄 변경' (관리자): 각 에이전트가 새 서버 응답을 확인한 뒤 옮겨 간다 */
  setAgentsServerUrl: (token: string, serverUrl: string, agentIds: string[]) =>
    request<{ agentId: string; ok: boolean; error: string | null }[]>('/api/agents/server-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ serverUrl, agentIds }),
    }),
  setUserPerms: (token: string, userId: string, perms: string[]) =>
    request<Org>(`/api/auth/perms/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ perms }),
    }),
  /** 로그인 화면 [관리]: 등록은 이름만, 이름 수정·삭제는 그 프로젝트 관리자 비밀번호 */
  createProject: (name: string) => request<Org>('/api/auth/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  renameProject: (id: string, name: string, password: string) =>
    request<Org>(`/api/auth/projects/${id}/rename`, { method: 'PUT', body: JSON.stringify({ name, password }) }),
  deleteProject: (id: string, password: string) =>
    request<Org>(`/api/auth/projects/${id}/purge`, { method: 'POST', body: JSON.stringify({ password }) }),
  setAgentProject: (agentId: string, projectId: string | null) =>
    request<Org>(`/api/agents/${agentId}/project`, { method: 'PUT', body: JSON.stringify({ projectId }) }),
  setFolderProject: (folderId: string, projectId: string | null) =>
    request<Org>(`/api/folders/${folderId}/project`, { method: 'PUT', body: JSON.stringify({ projectId }) }),

  pcStatuses: () => request<PcStatuses>('/api/pc-status'),
  setPcStatus: (agentId: string, status: PcStatusValue, note: string | null) =>
    request<PcStatuses>(`/api/agents/${agentId}/status`, { method: 'PUT', body: JSON.stringify({ status, note }) }),
  remoteUsage: () => request<RemoteUsage>('/api/remote-usage'),
  chatRooms: () => request<ChatRoom[]>('/api/chat/rooms'),
  /** userId: 화면이 처음 뜰 때는 사용자 헤더가 아직 설정되기 전일 수 있어 직접 넣는다 */
  pcLocks: () => request<PcLock[]>('/api/pc-locks'),
  lockPc: (agentId: string, pin: string) => request<void>(`/api/pc-locks/${agentId}`, { method: 'POST', body: JSON.stringify({ pin }) }),
  unlockPc: (agentId: string, pin: string) => request<void>(`/api/pc-locks/${agentId}/unlock`, { method: 'POST', body: JSON.stringify({ pin }) }),
  /** 이 브라우저에서만 다시 잠그기 */
  relockPc: (agentId: string) => request<void>(`/api/pc-locks/${agentId}/relock`, { method: 'POST' }),
  changePcPin: (agentId: string, pin: string, newPin: string) =>
    request<void>(`/api/pc-locks/${agentId}/pin`, { method: 'PUT', body: JSON.stringify({ pin, newPin }) }),
  removePcLock: (agentId: string, pin: string) => request<void>(`/api/pc-locks/${agentId}/remove`, { method: 'POST', body: JSON.stringify({ pin }) }),
  notes: (userId: string) => request<Note[]>('/api/notes', { headers: { 'X-User-Id': userId } }),
  createNote: (scope: Note['scope']) => request<Note>('/api/notes', { method: 'POST', body: JSON.stringify({ scope }) }),
  deleteNote: (id: string) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),
  updateNote: async (id: string, title: string, content: string, baseUpdatedAt: string): Promise<NoteSaveResult> => {
    const res = await fetch(`/api/notes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(currentUserId ? { 'X-User-Id': currentUserId } : {}) },
      body: JSON.stringify({ title, content, baseUpdatedAt }),
    })
    if (res.status === 409) return { conflict: (await res.json()) as Note }
    if (!res.ok) throw new Error(errorMessage(res.status, await res.text()))
    return { note: (await res.json()) as Note }
  },
  /** 이미지 올리기 (이미 줄인 것) → 메모에 넣을 주소 */
  uploadNoteImage: (image: Blob) =>
    request<{ url: string }>('/api/notes/images', { method: 'POST', body: image, headers: { 'Content-Type': image.type || 'image/jpeg' } }),
  chatMessages: (roomId: string, take = 200) => request<ChatMessage[]>(`/api/chat/rooms/${encodeURIComponent(roomId)}/messages?take=${take}`),
  createChatGroup: (name: string, memberIds: string[]) =>
    request<ChatRoom>('/api/chat/rooms', { method: 'POST', body: JSON.stringify({ name, memberIds }) }),
  openDirectChat: (userId: string) => request<ChatRoom>('/api/chat/direct', { method: 'POST', body: JSON.stringify({ userId }) }),
  inviteChat: (roomId: string, userIds: string[]) =>
    request<ChatRoom>(`/api/chat/rooms/${encodeURIComponent(roomId)}/invite`, { method: 'POST', body: JSON.stringify({ userIds }) }),
  kickChat: (roomId: string, userId: string) =>
    request<ChatRoom>(`/api/chat/rooms/${encodeURIComponent(roomId)}/kick/${encodeURIComponent(userId)}`, { method: 'POST' }),
  leaveChat: (roomId: string) => request<void>(`/api/chat/rooms/${encodeURIComponent(roomId)}/leave`, { method: 'POST' }),
  renameChat: (roomId: string, name: string) =>
    request<ChatRoom>(`/api/chat/rooms/${encodeURIComponent(roomId)}/name`, { method: 'PUT', body: JSON.stringify({ name }) }),
  sendChat: (roomId: string, text: string, mentions: string[]) =>
    request<ChatMessage>(`/api/chat/rooms/${encodeURIComponent(roomId)}/messages`, { method: 'POST', body: JSON.stringify({ text, mentions }) }),
  readChat: (roomId: string, messageId: number) =>
    request<void>(`/api/chat/rooms/${encodeURIComponent(roomId)}/read`, { method: 'POST', body: JSON.stringify({ messageId }) }),

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
  /** path 아래(하위 폴더까지)에서 이름에 q가 든 파일·폴더 */
  searchFiles: (agentId: string, path: string, q: string) =>
    request<DirectoryListing>(`/api/agents/${agentId}/files/search?${query({ path, q })}`),
  /** 진행 중인 전송(압축·풀기·가져오기·올리기·PC 간 복사) 취소 */
  cancelTransfer: (transferId: string) => request<void>(`/api/transfers/${transferId}/cancel`, { method: 'POST' }),
  /** 원격 PC의 미디어 파일을 서버로 옮기지 않고 바로 스트리밍하는 URL (video 태그 src용) */
  mediaUrl: (agentId: string, path: string) =>
    `/api/agents/${agentId}/media?${query({ path })}`,

  /** 원격조작 화면/입력 WebSocket 주소 (사용자 id는 '사용 중' 표시·차단에 쓴다) */
  remoteUrl: (agentId: string, userId: string | null) =>
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/agents/${agentId}/remote${userId ? `?user=${encodeURIComponent(userId)}` : ''}`,
  /** Ctrl+Alt+Del 보내기 (에이전트 서비스가 SAS 전송) */
  sendCtrlAltDel: (agentId: string) => request<void>(`/api/agents/${agentId}/remote/cad`, { method: 'POST' }),
  resultSets: () => request<ResultSetSummary[]>('/api/result-sets'),
  resultSet: (id: string) => request<ResultSet>(`/api/result-sets/${id}`),
  createResultSet: (body: CreateResultSet) =>
    request<ResultSet>('/api/result-sets', { method: 'POST', body: JSON.stringify(body) }),
  updateResultSet: (id: string, body: { name?: string; config?: unknown }) =>
    request<ResultSet>(`/api/result-sets/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteResultSet: (id: string) => request<void>(`/api/result-sets/${id}`, { method: 'DELETE' }),
  retryResultSetBackup: (id: string) => request<void>(`/api/result-sets/${id}/backup`, { method: 'POST' }),
  resultProfiles: () => request<ResultProfiles>('/api/result-profiles'),
  saveResultProfile: (agentId: string, profile: ResultProfile) =>
    request<ResultProfiles>(`/api/result-profiles/${encodeURIComponent(agentId)}`, { method: 'PUT', body: JSON.stringify(profile) }),
  removeResultProfile: (agentId: string) =>
    request<ResultProfiles>(`/api/result-profiles/${encodeURIComponent(agentId)}`, { method: 'DELETE' }),
  saveResultPreset: (presetId: string, preset: ResultPreset) =>
    request<ResultProfiles>(`/api/result-profiles/presets/${encodeURIComponent(presetId)}`, { method: 'PUT', body: JSON.stringify(preset) }),
  removeResultPreset: (presetId: string) =>
    request<ResultProfiles>(`/api/result-profiles/presets/${encodeURIComponent(presetId)}`, { method: 'DELETE' }),
  resultSetFileUrl: (id: string, path: string) => `/api/result-sets/${id}/file?${query({ path })}`,
  /** 테스트 PC에서 ffmpeg로 영상 구간 자르기 → 원래 영상 폴더에 저장 */
  trimVideo: (agentId: string, path: string, start: number, end: number) =>
    request<{ outputPath: string | null; error: string | null }>(`/api/agents/${agentId}/video/trim`, {
      method: 'POST',
      body: JSON.stringify({ path, start, end }),
    }),
  /** 영상 길이·fps 읽기. convert면 탐색 가능한 재생용 사본을 테스트 PC에 만든다 (캐시) */
  prepareVideo: (agentId: string, path: string, convert: boolean) =>
    request<VideoPrepareResult>(`/api/agents/${agentId}/video/prepare`, {
      method: 'POST',
      body: JSON.stringify({ path, convert }),
    }),
  /** PC 정보 패널 (패널을 열어 그 탭을 볼 때만 부른다) */
  pcSystemInfo: (agentId: string) => request<PcSystemInfo>(`/api/agents/${agentId}/info/system`),
  pcProcesses: (agentId: string) => request<{ items: ProcessEntry[] }>(`/api/agents/${agentId}/info/processes`),
  /** after: 이미 받은 마지막 측정 번호 */
  pcPerformance: (agentId: string, after: number) =>
    request<PerfHistory>(`/api/agents/${agentId}/info/performance?${query({ after })}`),
  pcDevices: (agentId: string) => request<{ items: DeviceEntry[] }>(`/api/agents/${agentId}/info/devices`),
  /** 테스트 PC 드라이브 남은 공간 · 재생용 사본 목록 */
  videoStorage: (agentId: string) => request<VideoStorageInfo>(`/api/agents/${agentId}/video/storage`),
  /** 재생용 사본 지우기 (원본은 그대로) */
  deleteVideoCache: (agentId: string, names: string[]) =>
    request<{ deleted: number; freedBytes: number; failed: string[] }>(`/api/agents/${agentId}/video/cache/delete`, {
      method: 'POST',
      body: JSON.stringify({ names }),
    }),
  /** 재생 준비 진행 (사본 만드는 중·ffmpeg 받는 중이 아니면 undefined) */
  prepareProgress: (agentId: string, path: string) =>
    request<VideoPrepareProgress | undefined>(`/api/agents/${agentId}/video/prepare/progress?${query({ path })}`),
  /** 테스트 PC에서 영상들의 프레임마다 크롭 이미지 유사도 재기 시작 → 작업 id */
  startImageSearch: (agentId: string, body: ImageSearchRequest) =>
    request<{ id: string }>(`/api/agents/${agentId}/video/image-search`, { method: 'POST', body: JSON.stringify(body) }),
  /** 진행·끝난 영상 결과. have: 이미 받은 영상 수 */
  imageSearchStatus: (agentId: string, id: string, have: number) =>
    request<ImageSearchStatus>(`/api/agents/${agentId}/video/image-search/${id}?${query({ have: String(have) })}`),
  /** 진행과 (video, offset)부터의 결과 조각 (긴 영상도 1MB씩 나눠 받는다) */
  imageSearchChunks: (agentId: string, id: string, video: number, offset: number) =>
    request<ImageSearchProgress>(`/api/agents/${agentId}/video/image-search/${id}?${query({ video, offset })}`),
  cancelImageSearch: (agentId: string, id: string) =>
    request<void>(`/api/agents/${agentId}/video/image-search/${id}`, { method: 'DELETE' }),
  /** '원격 사용 중' 표시가 남았을 때 지우기 */
  clearRemoteUsage: (agentId: string) => request<void>(`/api/remote-usage/${agentId}`, { method: 'DELETE' }),
  /** Linux PC: Wayland를 끄고(Xorg) 재부팅 */
  switchToX11: (agentId: string) => request<void>(`/api/agents/${agentId}/linux/x11`, { method: 'POST' }),

  /** 파일을 브라우저 다운로드 폴더로 바로 내려받는 URL (첨부) */
  downloadUrl: (agentId: string, path: string) =>
    `/api/agents/${agentId}/download?${query({ path })}`,

  fetchFile: (agentId: string, path: string) =>
    request<Transfer>(`/api/agents/${agentId}/files/fetch`, { method: 'POST', body: JSON.stringify({ path }) }),
  /** pushFile과 같지만 PC가 다 받을 때까지 기다린다 (원격조작 파일 붙여넣기) */
  pushFileAndWait: (agentId: string, destinationPath: string, file: Blob) =>
    request<Transfer>(`/api/agents/${agentId}/files/push?${query({ path: destinationPath, wait: 'true' })}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
  /** 내 PC: 원격 PC에서 복사한 파일을 받아 둘 새 폴더 */
  prepareClipboard: (agentId: string) => request<string>(`/api/agents/${agentId}/clipboard/prepare`, { method: 'POST' }),
  /** 내 PC: 받은 파일을 사용자 클립보드에 넣는다 (Ctrl+V로 붙여넣기) */
  setClipboardFiles: (agentId: string, paths: string[]) =>
    request<void>(`/api/agents/${agentId}/clipboard/files`, { method: 'POST', body: JSON.stringify({ paths }) }),
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
  compressFiles: (agentId: string, paths: string[], destinationFolder: string, archiveName?: string, splitBytes = 0, format: ArchiveFormat = 'zip') =>
    request<Transfer>(`/api/agents/${agentId}/files/compress`, {
      method: 'POST',
      body: JSON.stringify({ paths, destinationFolder, archiveName: archiveName ?? null, splitBytes, format }),
    }),
}
