# HANDOFF — PC Manager ("Don't Move")

작성: 2026-10-06 · 최신 릴리스 **v0.8.21** (릴리스·런처 exe 다운로드 확인됨) (main = `e60897f`, 작업 트리 깨끗, 모두 푸시됨)
연동 프로젝트: NPMS 포털 `E:/Project/Jira_MCP` (원격 `choisjin/NPMS`, main = `b515570`, 푸시됨)

테스트 PC 관리 도구. 웹 대시보드(React) + ASP.NET Core 서버 + 단일 exe .NET 에이전트 + **서버 런처(0.8.21 신규)**.
구조·설계는 `docs/ARCHITECTURE.md`, 발표용 설명은 `docs/PRESENTATION.md`.

---

## 1. 목표 (이번 대화)

프로젝트별로 PC Manager를 따로 운영한다.
- 한 PC에서 PC Manager 서버를 **2~3개**(프로젝트별) 띄운다 → **서버 런처**가 실행·종료·추가·일괄 업데이트를 맡는다.
- NPMS 포털은 한 PC에 하나만. 포털의 **테스트 운영 → 운영 관재 → PC Manager** 탭은 런처가 띄운 서버 하나에 **연결만** 한다
  (예전 "벤치 통합 관리" 스텁 자리).

---

## 2. 현재 진행 상황

### PC_Manager (0.8.20 → 0.8.21)
- **포터블 실행** (0.8.20, `src/PcManager.Server/Program.cs`, `ServerOptions.cs`의 `ServerArgs`)
  - `PcManager.Server.exe --port 5070 [--data D:\...]` → `UseUrls(http://*:포트)`, ContentRoot = exe 폴더.
  - 설치형 설정 `C:\ProgramData\PcManager\Server\server.json`을 **읽지 않음** → 같은 PC의 설치형 서버·다른 인스턴스와 안 겹침.
  - `ServerOptions.Portable` → 대시보드의 서버 자가 업데이트 차단(설치기가 Windows 서비스를 고치므로). 메시지는 런처 사용 안내.
  - 부수 수정: `ServerOptions`를 `Configure<ServerOptions>`로 등록 (그전엔 `IOptions`가 기본값이라 `GitHubToken`·업데이트 주기 설정이 무시됐음).
  - HTTP만 (HTTPS·키보드 잠금 없음).
- **서버 런처** (0.8.21, `src/PcManager.ServerLauncher`, 릴리스 `PcManager-ServerLauncher-<버전>.exe`)
  - WinForms 단일 exe. 폴더 구성(런처 exe 폴더 기준): `launcher.json`, 공용 `server\`, `instances\이름\data`, `instances\이름\server.log`.
  - 서버 = 런처의 자식 프로세스, **Job Object(KILL_ON_JOB_CLOSE)** 로 묶음 → 런처가 강제 종료돼도 서버 안 남음.
  - 정상 종료: 서버 `Api/LauncherEndpoints.cs`의 `POST /api/launcher/shutdown` (환경변수 `PCM_LAUNCHER_TOKEN`으로 실행마다 새 토큰, localhost만, 토큰 없으면 경로 자체 없음). 15초 내 안 끝나면 Kill.
  - 비정상 종료 시 3초 뒤 자동 재시작, 5분 안 3번이면 멈추고 "오류".
  - 일괄 업데이트: `/releases/latest` 리디렉션으로 버전 확인(API 미사용) → zip 다운로드 → `server.new`에 `server/`만 풀기 → 실행 중 서버 중지 → `server`↔`server.old` 교체 → 다시 시작. `[zip으로 업데이트…]`는 오프라인용.
  - 서버 추가/설정/삭제(이름·포트·데이터 폴더 중복 검사, 방화벽은 `netsh` 승격 실행), 트레이 상주, `HKCU\...\Run` 로그인 자동 실행(`--minimized`), 폴더당 런처 1개(Mutex).
  - `build/package.ps1`에 런처 게시 추가, `installer/server/README.txt`에 사용법.

### NPMS (`E:/Project/Jira_MCP`)
- `index.html` NAV: `bench` 스텁 → `{ id: 'pcmanager', kind: 'pcm' }`, `#view-pcm` (상단 바: 서버 주소, ⬇ 에이전트 다운로드, 주소 복사, 새 창).
  iframe은 **프록시 없이** `http://<host>:<port>/` 직접 (대시보드가 SignalR/WebSocket을 써서 Flask 프록시 불가).
- `server.py`: `GET /api/pcm/info` → `{port, host, up, host_ip}`. 설정 `services/PC_Manager/config.json` (`{"port":5063,"host":""}`, 요청마다 읽음 → 저장 즉시 반영). 설정 화면 CONFIG_FILES에 항목 있음.
- 포털은 PC Manager를 **띄우지도 업데이트하지도 않음** (SERVICES 목록에 없음). 예전 `pcm_setup.py`(자동 다운로드)는 삭제됨.

---

## 3. 잘 된 방법

- 포터블 모드 판단을 `--port` 인자 하나로 (설정 파일이 아니라 실행 인자라 설치형과 섞이지 않음).
- 런처 시험: 스크래치 폴더에 런처 + `dotnet publish` 서버(+`web/dist`→`wwwroot`, `artifacts`의 옛 에이전트 exe→`agent\PcManager-Agent-Setup.exe`)를 배치, `launcher.json`을 미리 써 두고 실행.
- UI 자동화(PowerShell UIAutomation): 버튼 Invoke는 모달이 닫힐 때까지 막히므로 **`Start-Job`** 안에서 누르고, 메시지 상자는 `$win.FindFirst('Children', ClassName '#32770')`로 찾아 **Enter(SendKeys)** 로 확인.
- GitHub 업데이트 경로 시험: `server\`를 `artifacts/PcManager-Server-0.7.0.zip`의 서버로 바꿔 두면 "새 버전 있음" → 실제 다운로드·교체까지 확인 가능.
- 난독화 확인: `dotnet publish src/PcManager.ServerLauncher -c Release -r win-x64 --self-contained true -p:PcmObfuscate=true -p:PublishSingleFile=true ...` 후 기존 `launcher.json`으로 실행.

## 4. 안 된 방법 (반복하지 말 것)

- **PC Manager 대시보드를 NPMS Flask 프록시로 감싸기**: `requests` 기반 프록시는 WebSocket 불가 → iframe 직접 연결로.
- **포털이 PC Manager를 자식으로 띄우고 GitHub에서 자동 다운로드**: 한 번 만들었다가 사용자 요청으로 런처 방식으로 대체(관리 주체 일원화).
- **서버 바이너리를 Jira_MCP 저장소에 복사**: 사용자가 취소 (별도 프로젝트 유지).
- UI 자동화로 **공용 파일 열기 창(OpenFileDialog)** 조작: UIA 조회가 시간 초과/창이 닫힘 → zip 업데이트는 수동 시험 필요. `Task.Run([Action]{...})`·`Start-Process pwsh`로 버튼 누르기도 안 됨(`Start-Job`만 됨).
- 메시지 상자 확인 버튼을 UIA Invoke로 누르기 실패("지원되지 않는 Pattern") → Enter 키.

---

## 5. 다음 할 일

1. ~~v0.8.21 릴리스 확인~~ — 완료 (`PcManager-ServerLauncher-0.8.21.exe` 다운로드 200).
2. **실제 서버 PC에서 런처 시험 (사용자 확인)**: 방화벽 열기(UAC), zip 업데이트, 트레이·로그인 자동 실행, 서버 2~3개 동시 운영, 에이전트 연결.
   0.8.20 서버에는 종료 경로가 없어 중지가 15초 뒤 강제 종료됨 → 런처로 0.8.21 이상 받으면 해소.
3. NPMS 쪽: 서버 PC에 `services/PC_Manager/config.json` 작성(런처 서버 포트). 포털과 다른 PC면 `host` 지정.
4. 제안(미착수): 런처 자체 업데이트, 런처에서 방화벽 규칙 삭제(서버 삭제 시), NPMS 백업에 PC Manager 데이터 포함 여부.
5. 이전부터 남은 일:
   - 0.8.18 서버 자가 업데이트(설치형) 실전 확인, 실패 시 `install.log`로 진단.
   - **저장소 비공개 전환 준비**: 업데이트 확인·다운로드를 GitHub 토큰 방식으로 (서버 `UpdateService`, **런처 `ServerPackage`도** 리디렉션·`releases/download` 주소를 씀 → 비공개면 둘 다 API 자산 엔드포인트 + `Accept: application/octet-stream`로 바꿔야 함).
   - 실제 환경 확인: 셸 아이콘(서비스), 원격 로그인 재연결, 엑셀 열기·저장, NAS/도메인 공유 자격증명.
   - 상용 난독화 검토(.NET Reactor 등).

---

## 6. 꼭 알아야 할 규칙 / 함정

### 난독화 (Obfuscar, `Directory.Build.targets`)
- `build/package.ps1`이 `-p:PcmObfuscate=true`로 게시 (개발 빌드는 난독화 안 함). `PcManager.*` 프로젝트 전부 대상(런처 포함). 도구는 `dotnet-tools.json`.
- **새 서버 API 처리기는 반드시 `PcManager.Server.Api` 네임스페이스에** — ASP.NET이 매개변수 이름으로 값을 넣는데 Obfuscar가 지움.
- **JSON으로 읽는 비공개 형식**에는 `[System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]` (런처 `InstanceConfig`·`LauncherConfig`도 적용). 익명 형식은 규칙으로 제외.

### 서버 실행 방식
- 설치형(Windows 서비스 `PcManagerServer`, `install-server.ps1`, 자가 업데이트 가능) vs 포터블(`--port`, 런처가 관리, 자가 업데이트 불가). 두 방식 공존 가능.
- 포터블은 Kestrel 설정 없이 `UseUrls`만 → HTTPS 없음.

### 서버 자가 업데이트 (설치형)
- 설치기는 `DetachedProcess.Start`(숨긴 콘솔). **`DETACHED_PROCESS` 쓰지 말 것** (powershell이 아무것도 안 하고 끝남).
- `install-server.ps1`은 BOM 있는 UTF-8 유지(PowerShell 5.1).

### 서비스(SYSTEM) 컨텍스트
- 사용자 파일 연결·문서 폴더·프로그램 실행은 사용자 세션 기준 → `SessionProcess.StartAsSessionUser`, `GetUserDocumentsFolder` 등.

### 릴리스 절차
- `Directory.Build.props` 버전 올림 → 커밋 → push main → `git tag vX && git push origin vX` → GitHub Actions가 빌드·릴리스 (`artifacts/*.zip`, `*.exe` 전부 업로드 → 런처 exe도 자동 포함).
- **릴리스 확인은 GitHub API 반복 조회 금지** (회사 IP 비인증 한도 60/시간). `releases/latest` 리디렉션을 3분 간격으로.
- push 전에는 항상 사용자 확인 (CLAUDE.md). NPMS(Jira_MCP)도 마찬가지.

### 개발 환경
- 개발 서버 `dotnet run --launch-profile http` (5063), 에이전트 `--launch-profile console`, 대시보드 `web`에서 `npm run dev` (5173).
- 포터블 서버 단독 시험: `src/PcManager.Server/bin/Debug/net10.0/PcManager.Server.exe --port 5099 --data <스크래치>`.
- NPMS 포털 시험: `cd E:/Project/Jira_MCP && NPMS_AUTOSTART=0 PORT=5077 py -3.10 server.py` (다른 서비스 자동 기동 안 함). 포털 첫 화면은 로그인 오버레이(`#portalLogin`, Operation Report 필요)라 화면 확인 시 JS로 숨김.
- 내 PC 프로그램으로 열기 시험 시 에이전트에 `PCM_EDIT_NO_LAUNCH=1`.
- 패키징(`build/package.ps1`)은 `npm ci`로 `node_modules`를 지우므로 **dev 서버(vite)를 끄고** 실행.
- Git Bash 히어독에서 백슬래시가 망가지는 경우가 많음 → 파일 수정은 스크립트 파일(Write)로. Jira_MCP 파일 일괄 수정은 Python 스크립트(`py -3.10`)로 했음.
- Node `fs.rmSync`가 한글 경로에서 프로세스를 죽이는 현상 있음.
- e2e·UI 자동화 스크립트는 세션 스크래치 폴더에 있었음 — 새 대화에서는 필요 시 다시 작성.

---

## 7. 이전 대화(0.8.9 → 0.8.19)에서 만든 것 (요약)

- 탐색기(자세히 보기·숨김 항목·압축 파일 열기/풀기·텍스트/이미지/PDF 보기), 더블클릭 = 내 PC 프로그램으로 열기(저장 감시 후 되돌림)
- PC 간·공유 폴더↔PC 복사·이동, 공유 폴더(사용자별 자격증명, `\\서버` 등록), 윈도우 셸 아이콘
- 원격: 로그인 후 자동 재연결 / PiP: 모서리 고정·최상위 표시 / 업데이트: API 한도 시 리디렉션 확인, `install.log`
- 난독화(Obfuscar), 채팅방(1:1·그룹, `ChatRoomStore`, `Api/ChatEndpoints.cs`, `ChatPanel.tsx`)
