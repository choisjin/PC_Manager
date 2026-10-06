# HANDOFF — PC Manager ("RemoteKit")

작성: 2026-10-06 · 최신 릴리스 **v0.8.24** (main = `bd458cc`, 작업 트리 깨끗, 모두 푸시됨)
연동 프로젝트: NPMS 포털 `E:/Project/Jira_MCP` (원격 `choisjin/NPMS`, main = `c1230ae`, 푸시됨)

테스트 PC 관리 도구. 웹 대시보드(React) + ASP.NET Core 서버 + 단일 exe .NET 에이전트 + **서버 런처**.
구조·설계는 `docs/ARCHITECTURE.md`, 발표용 설명은 `docs/PRESENTATION.md`.

실제 운영 환경(사용자 서버 PC): 런처 폴더 `D:\PC_ManagerServers`, 서버 `Nissan` (HTTP 5065 / HTTPS 5066),
서버 PC IP `10.176.144.50`, NPMS 폴더 `D:\NPMS`, 주소 `https://10.176.144.50:5000` (http:// 도 https 로 넘어감).

---

## 1. 목표 (이번 대화)

프로젝트별로 PC Manager를 따로 운영한다.
- 한 PC에서 PC Manager 서버를 **2~3개**(프로젝트별) 띄운다 → **서버 런처**가 실행·종료·추가·일괄 업데이트를 맡는다.
- NPMS 포털은 한 PC에 하나만. **테스트 운영 → 운영 관재 → PC Manager** 탭은 런처가 띄운 서버 하나에 **연결만** 한다.
- 원격조작 단축키(Alt+Tab·Win 키 = 키보드 잠금)가 **NPMS 탭 안에서도** 동작해야 한다 → HTTPS 필요.

---

## 2. 현재 상태 (버전별)

### PC_Manager
- **0.8.20 포터블 실행** (`src/PcManager.Server/Program.cs`, `ServerOptions.cs`의 `ServerArgs`)
  - `PcManager.Server.exe --port 5070 [--data D:\...] [--https-port 5071 --cert X.pfx]`, ContentRoot = exe 폴더.
  - 설치형 설정 `C:\ProgramData\PcManager\Server\server.json`을 **읽지 않음** → 설치형 서버·다른 인스턴스와 안 겹침.
  - `ServerOptions.Portable` → 대시보드의 서버 자가 업데이트 차단(런처 사용 안내).
  - `ServerOptions`를 `Configure<ServerOptions>`로 등록 (그전엔 `GitHubToken`·업데이트 주기 설정이 무시됐음).
- **0.8.21 서버 런처** (`src/PcManager.ServerLauncher`, 릴리스 `PcManager-ServerLauncher-<버전>.exe`)
  - WinForms 단일 exe. 런처 exe 폴더 기준: `launcher.json`, 공용 `server\`, `instances\이름\data`, `instances\이름\server.log`, `https\`.
  - 서버 = 자식 프로세스, **Job Object(KILL_ON_JOB_CLOSE)** → 런처가 강제 종료돼도 서버 안 남음.
  - 정상 종료: 서버 `Api/LauncherEndpoints.cs` `POST /api/launcher/shutdown` (환경변수 `PCM_LAUNCHER_TOKEN`, 실행마다 새 토큰, localhost만). 15초 내 안 끝나면 Kill.
  - 비정상 종료 시 3초 뒤 자동 재시작, 5분 안 3번이면 "오류"로 멈춤.
  - 일괄 업데이트: `/releases/latest` 리디렉션으로 버전 확인(API 미사용) → zip → `server.new` → 실행 중 서버 중지 → `server`↔`server.old` 교체 → 재시작. `[zip으로 업데이트…]`(오프라인).
  - **런처 자신은 업데이트하지 않음** → 런처가 바뀐 릴리스는 사용자가 exe를 직접 교체해야 함.
  - 서버 추가/설정/삭제, 방화벽(`netsh` 승격), 트레이, `HKCU\...\Run` 로그인 자동 실행(`--minimized`), 폴더당 런처 1개(Mutex).
- **0.8.22 PC 목록 "목록에서 삭제"** (우클릭, 연결 끊긴 PC만)
  - 서버 `DELETE /api/agents/{id}` (`Api/ApiEndpoints.cs`, 연결 중이면 409) + Hub `AgentRemoved`. 대시보드 `PcTree.tsx` 메뉴, `useDashboard.removeAgent`.
  - Agents 행만 지움 (실행·전송 기록, 별칭·프로젝트는 남김). 에이전트가 다시 연결하면 `AgentHub` 등록 로직이 새로 만든다.
- **0.8.23 포터블 HTTPS**
  - 런처가 이 PC용 자체 서명 인증서 생성: `https\PcManager-Server.pfx`(암호 없음) + `.cer`, 주체 `CN=PC Manager Server (PC이름)`,
    SAN = PC 이름·FQDN·localhost·모든 IPv4·127.0.0.1. 이름·IP 바뀌거나 30일 내 만료면 재발급 (`ServerCertificate.cs`).
  - 서버마다 HTTPS 포트(기본 HTTP+1, `InstanceConfig.HttpsPort`: null=+1, 0=끔). 서버는 `--https-port --cert`로 Kestrel 두 포트 Listen.
  - 서버 PC 신뢰: 런처가 `certutil -addstore Root`를 승격 실행(UAC). 에이전트 PC: 등록 시 `/api/install/PcManager-Server.cer`를 받아 자동 신뢰(기존 `ServerCertificateTrust`). 그 외 PC: 대시보드 [PC 추가] 창 "인증서 설치 도구".
  - 대시보드 HTTPS 주소 = 요청 호스트 + HTTPS 포트. **에이전트 접속 주소는 HTTPS로 열어도 HTTP 주소** (에이전트는 등록 후에야 인증서를 신뢰하므로).
- **0.8.24 iframe 키보드 잠금 대행** (`RemoteModal.tsx` `parentKeyboardLock`)
  - iframe 안에서는 Chrome이 `keyboard.lock()`을 거부("primary top-level browsing context"에서만) → 전체 화면 시
    부모에 `postMessage({pcmKeyboardLock:'lock'|'unlock', id})`, 응답 `{pcmKeyboardLockResult:id, ok, error}`. 1.5초 무응답이면 "새 창으로 여세요" 안내.

### NPMS (`E:/Project/Jira_MCP`)
- 메뉴: `bench` 스텁 → `{ id: 'pcmanager', kind: 'pcm' }`, `#view-pcm` (상단 바: 서버 주소, ⬇ 에이전트 다운로드, 주소 복사, 새 창).
  iframe은 **프록시 없이** PC Manager 포트로 직접 (대시보드가 SignalR/WebSocket을 써서 Flask 프록시 불가).
- `server.py` `GET /api/pcm/info` → `{port, host, up, https_port, host_ip}` (PC Manager `/api/install/info`의 `httpsUrl`에서 HTTPS 포트 추출).
  설정 `services/PC_Manager/config.json` `{"port":5063,"host":""}` (요청마다 읽음). 포털은 PC Manager를 띄우지도 업데이트하지도 않음.
- **실행 = `run_server.bat` 하나** (사용자 요청: "서버 실행하면 모든 게 되도록")
  - **임베디드 Python 3.10.11** (`python\`, gitignore): `setup_python.ps1`이 첫 실행 때 python.org 임베더블 zip + get-pip + `requirements.txt` 설치.
    `requirements.txt` 해시가 바뀌면 재설치(실행 시, 관리 [패치] 시). PC에 설치된 파이썬과 완전히 분리(PYTHONPATH·사용자 site 무시).
    임베디드는 스크립트 폴더를 `sys.path`에 안 넣음 → `python\sitecustomize.py`가 넣어 줌(각 서비스가 자기 폴더 모듈 import).
    서비스는 `sys.executable`로 뜨므로 모두 같은 임베디드 파이썬.
  - **HTTPS 자동 (포트 5000 하나)**: 설정 없이, 이 PC에서 도는 `PcManager.Server.exe`의 `--cert` 값(없으면 런처 exe 폴더 `https\PcManager-Server.pfx`)을
    PowerShell CIM으로 찾아 사용 (`_find_pcm_pfx`). `NPMS_HTTPS_PFX`로 직접 지정, `NPMS_HTTPS=0`이면 끔. 못 찾거나 실패하면 HTTP.
    `_serve_https`: werkzeug `ThreadedWSGIServer.finish_request`에서 첫 바이트를 엿봐(TLS=0x16) TLS로 감싸거나, 평문이면 `301 https://…`로 넘김.
  - HTTPS일 때: iframe·에이전트 다운로드·새 창 모두 PC Manager HTTPS 주소. 페이지가 `message`를 받아 `navigator.keyboard.lock()` 대행 (iframe 출처만 허용).
  - `run_server.local.bat`(gitignore)이 있으면 읽음 — PC별 덮어쓰기용(보통 불필요).
- **사용자 확인 완료: NPMS 탭 안에서 원격조작 Alt+Tab·Win 키 정상 동작.**

---

## 3. 잘 된 방법

- 포터블 모드 판단을 `--port` 인자 하나로 (설정 파일이 아니라 실행 인자라 설치형과 섞이지 않음).
- 런처 시험: 스크래치 폴더에 런처 + `dotnet publish` 서버(+`web/dist`→`server\wwwroot`)를 배치, `launcher.json`을 미리 쓰고
  **`--minimized`로 실행**(인증서 신뢰 확인 창이 안 뜸).
- 실제 에이전트 없이 PC 목록 시험: 서버 DB(`pcmanager.db`)의 `Agents` 테이블에 Python `sqlite3`로 행을 넣음.
- HTTPS·iframe 시험: Playwright MCP는 자체 서명 인증서를 못 넘김 → Node 스크립트로 `npx` 캐시의 playwright를 require,
  `chromium.launch({ channel: 'chrome' })` + `newContext({ ignoreHTTPSErrors: true })`. iframe은 `page.frames()`로 찾아 `evaluate`.
- 인증서 검증: PowerShell `SslStream` 콜백으로 정책 오류 확인 → `RemoteCertificateChainErrors`만 나오면 이름·IP는 맞음(신뢰만 하면 됨).
- UI 자동화(UIAutomation): 모달을 띄우는 버튼은 **`Start-Job`** 안에서 Invoke, 메시지 상자는 `#32770`을 찾아 Enter.
- GitHub 업데이트 경로 시험: `server\`를 옛 버전(`artifacts/PcManager-Server-0.7.0.zip`)으로 바꿔 두고 [일괄 업데이트].
- Jira_MCP·여러 줄 수정은 Python 패치 스크립트(스크래치)로 — 문자열 일치 assert 후 치환.

## 4. 안 된 방법 (반복하지 말 것)

- PC Manager 대시보드를 NPMS Flask 프록시로 감싸기 → WebSocket 불가.
- 포털이 PC Manager를 직접 띄우고 GitHub에서 받기 → 런처 방식으로 대체. 서버 바이너리를 Jira_MCP에 복사 → 사용자 취소.
- **iframe 안에서 `navigator.keyboard.lock()` 직접 호출** → HTTPS여도 거부됨. 부모(최상위) 문서가 대신 호출해야 함.
- UI 자동화로 OpenFileDialog 조작 → UIA 시간 초과. 메시지 상자 버튼 UIA Invoke → "지원되지 않는 Pattern"(Enter 키로).
- Git Bash 히어독 안에 C# 문자열 `\n`/따옴표가 많은 Python 코드 → 셸 파싱 오류·`\n`이 실제 줄바꿈으로 들어감. **Write로 스크립트 파일을 만들 것.**
- 사용자에게 bat 수정 안내 시 "`rem`만 지우라" → `set` 줄까지 지운 사례. 넣을 줄을 그대로 보여 줄 것.

---

## 5. 다음 할 일

1. **서버 PC 적용 (사용자, 1회)**: 서버 PC `run_server.bat`을 직접 고쳐 둔 상태라 pull이 막힘 →
   `cd /d D:\NPMS && git checkout run_server.bat && git pull` 후 `run_server.bat` 실행 (첫 실행 때 파이썬 자동 설치).
   이후로는 `run_server.bat` 실행만. 5443 방화벽 규칙은 남아 있어도 무해. NPMS를 여는 다른 PC는 인증서 신뢰(대시보드 [PC 추가] → 인증서 설치 도구)만 필요.
2. NPMS가 예전 설치형 서버(5063)에 연결돼 있었는지 확인 이슈가 있었음 → 런처 서버(5065)로 통일됐는지, 데이터 이전이 필요했는지 사용자 확인.
3. 미시험: 런처 [HTTPS 인증서 신뢰(이 PC)](UAC), zip 업데이트, 방화벽 열기, "목록에서 삭제" 후 실제 에이전트 재등록, 연결 중 PC 삭제 거부(409).
4. 제안(미착수): 런처 자체 업데이트, 서버 삭제 시 방화벽 규칙 삭제, NPMS 백업에 PC Manager 데이터, HTTP→HTTPS 자동 전환(옛 즐겨찾기).
5. 이전부터 남은 일:
   - 설치형 서버 자가 업데이트 실전 확인(`install.log`).
   - **저장소 비공개 전환 준비**: 서버 `UpdateService`와 **런처 `ServerPackage`** 모두 리디렉션·`releases/download`를 씀 → 토큰 + API 자산 엔드포인트(`Accept: application/octet-stream`)로.
   - 실제 환경 확인: 셸 아이콘(서비스), 원격 로그인 재연결, 엑셀 열기·저장, NAS/도메인 공유 자격증명. 상용 난독화 검토.

---

## 6. 꼭 알아야 할 규칙 / 함정

### 난독화 (Obfuscar, `Directory.Build.targets`)
- 배포 빌드만 `-p:PcmObfuscate=true`. `PcManager.*` 프로젝트 전부(런처 포함).
- **새 서버 API 처리기는 반드시 `PcManager.Server.Api` 네임스페이스에** (매개변수 이름 보존).
- **JSON으로 읽는 비공개 형식**에는 `[System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]` (런처 `InstanceConfig`·`LauncherConfig`). 계산 속성은 `[JsonIgnore]`.

### 서버 실행 방식
- 설치형(Windows 서비스 `PcManagerServer`, `install-server.ps1`, LocalMachine\My 인증서 `CN=PC Manager Server`, 자가 업데이트 가능)
  vs 포터블(런처, `--port`/`--https-port`/`--cert`, 자가 업데이트 불가). 공존 가능 — 인증서 주체가 달라 신뢰 저장소에서 서로 안 지움.
- HTTPS 관련 브라우저 규칙: 키보드 잠금·WebCodecs는 보안 컨텍스트 필요, 키보드 잠금은 **최상위 문서만**,
  HTTPS 페이지 안의 HTTP iframe·HTTP 다운로드는 차단됨.

### 서버 자가 업데이트 (설치형)
- 설치기는 `DetachedProcess.Start`(숨긴 콘솔). **`DETACHED_PROCESS` 쓰지 말 것**. `install-server.ps1`은 BOM 있는 UTF-8.

### 서비스(SYSTEM) 컨텍스트
- 사용자 파일 연결·문서 폴더·프로그램 실행은 사용자 세션 기준 → `SessionProcess.StartAsSessionUser` 등.

### 릴리스 절차
- `Directory.Build.props` 버전 올림 → 커밋 → push main → `git tag vX && git push origin vX` → Actions가 빌드·릴리스(zip·exe 전부).
- **릴리스 확인은 GitHub API 반복 조회 금지** (회사 IP 한도 60/시간). `releases/latest` 리디렉션을 3분 간격으로.
- push 전에는 항상 사용자 확인 (CLAUDE.md). NPMS(Jira_MCP)도 마찬가지.
- 대시보드(web) 변경은 서버 릴리스에 들어감 → 런처 [일괄 업데이트]로 반영. 런처 코드 변경은 exe 교체 필요.

### 개발 환경
- 개발 서버 `dotnet run --launch-profile http` (5063), 에이전트 `--launch-profile console`, 대시보드 `web`에서 `npm run dev` (5173).
- 포터블 서버 단독: `src/PcManager.Server/bin/Debug/net10.0/PcManager.Server.exe --port 5099 --data <스크래치>` (대시보드 보려면 `web/dist`를 그 폴더 `wwwroot`로 복사).
- NPMS 시험: `cd E:/Project/Jira_MCP && powershell -File setup_python.ps1` 후 `NPMS_AUTOSTART=0 PORT=5077 python\python.exe server.py`
  (런처가 떠 있으면 HTTPS 자동, 없으면 HTTP). 포털 출력은 리디렉션 시 버퍼링돼 로그 파일에 늦게 나옴.
  포털 첫 화면 로그인 오버레이(`#portalLogin`)는 JS로 숨기고 `selectMajor('ops','asset','pcmanager')`.
- 이 PC에는 설치형 서버·에이전트 설정이 있을 수 있음 → 실제 에이전트를 시험 서버에 붙이지 말 것(설정 오염).
- 패키징(`build/package.ps1`)은 `npm ci`로 `node_modules`를 지우므로 dev 서버(vite)를 끄고 실행.
- Node `fs.rmSync`가 한글 경로에서 프로세스를 죽이는 현상 있음. 시험 스크립트는 세션 스크래치에 있었음(새 대화에선 다시 작성).

---

## 7. 이전 대화(0.8.9 → 0.8.19)에서 만든 것 (요약)

- 탐색기(자세히 보기·숨김 항목·압축 파일·텍스트/이미지/PDF 보기), 더블클릭 = 내 PC 프로그램으로 열기
- PC 간·공유 폴더↔PC 복사·이동, 공유 폴더(사용자별 자격증명), 윈도우 셸 아이콘
- 원격: 로그인 후 자동 재연결 / PiP / 업데이트: API 한도 시 리디렉션 확인, `install.log`
- 난독화(Obfuscar), 채팅방(1:1·그룹, `ChatRoomStore`, `Api/ChatEndpoints.cs`, `ChatPanel.tsx`)
