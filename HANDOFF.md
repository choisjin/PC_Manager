# HANDOFF — PC Manager ("Don't Move")

작성: 2026-10-02 · 최신 릴리스 **v0.8.18** (main = `3585eb8`, 작업 트리 깨끗, 모두 푸시됨)

테스트 PC 관리 도구. 웹 대시보드(React) + ASP.NET Core 서버 + 단일 exe .NET 에이전트.
구조·설계는 `docs/ARCHITECTURE.md`, 발표용 설명은 `docs/PRESENTATION.md`.

---

## 1. 현재 상태 / 사용자가 확인해야 할 것

| 항목 | 상태 |
|---|---|
| 서버 자가 업데이트(대시보드 버튼) | **0.8.17에서 근본 원인 수정**: 설치기 powershell을 `DETACHED_PROCESS`로 띄우면 스크립트를 실행하지 않고 바로 종료됐음 → 숨긴 콘솔(`CREATE_NO_WINDOW`)로 변경. 0.8.17 → 0.8.18을 대시보드 버튼으로 올리는 것이 **첫 실전 확인**. 실패 시 3분 뒤 업데이트 창에 실패+`install.log` 끝부분 표시 |
| 셸 아이콘(엑셀·PDF 등) | 서비스(SYSTEM)는 사용자 파일 연결을 못 봐서 0.8.12에서 사용자 세션 도우미(`--shell-icons`)로 꺼내게 함. **서비스 환경에서 실제 확인 필요** |
| 원격 로그인 후 자동 재연결 | 서버가 원격 세션 프로세스 종료 시 새 세션에 다시 띄워 같은 연결에 잇는다. 실제 로그인 화면 전환은 미검증 (PnP_PC에서 확인 필요) |
| 내 PC 프로그램으로 열기(엑셀) | 개발 환경에서는 `PCM_EDIT_NO_LAUNCH=1`로 실행을 막고 시험함 → **실제 엑셀 실행·저장 반영은 사용자 확인 필요** |
| 난독화 배포(0.8.16~) | 이 PC에서 전 기능 시험 통과. 실제 서비스 설치 환경은 0.8.16부터 처음 |
| 저장소 공개 여부 | 현재 **공개**. 사용자가 추후 비공개로 바꿀 예정 → 그 전에 업데이트 확인/다운로드를 토큰 방식으로 바꿔야 함(아래 4번) |

---

## 2. 이번 대화(0.8.9 → 0.8.18)에서 만든 것

- **탐색기**: 자세히 보기 … 처리·표시 열 설정, 숨김 항목 보기, 압축 파일 폴더처럼 열기·골라 풀기·암호(zip/7z/rar/tar/tar.gz/분할 zip, CP949 이름), 텍스트 보기/편집(인코딩·줄바꿈 유지, 충돌 감지), 이미지·PDF 보기, 우클릭 "내려받지 않고 보기/편집/재생"
- **더블클릭 = 내 PC 프로그램으로 열기**: 편집 PC 에이전트가 `문서\PC Manager 편집\PC이름`에 받아 사용자 권한으로 실행 → 저장 감시 → 원래 PC로 되돌림(충돌 시 `이름 (충돌 날짜)`), `.bak`은 보기 메뉴 설정(기본 끔), 사본 자동 정리(닫힘+10분), Setting 페이지에 편집 폴더 열기·정리
- **PC 간·공유 폴더↔PC 파일/폴더 복사·이동** (서버 중계)
- **공유 폴더**: 사용자별 목록·자격증명(NEW_CREDENTIALS 로그온으로 사용자별 계정 충돌 없음), 권한 필요한 폴더만 자격증명 필수(probe), `\\서버`만으로 등록(NetShareEnum), 별칭·순서 변경, PC 목록 위로 이동
- **아이콘**: 윈도우 정식 셸 아이콘(대시보드를 연 PC 에이전트 → 없으면 서버), 실패 시 직접 그린 종류별 아이콘
- **원격**: 로그인으로 세션 바뀌면 자동 재연결, 도우미 오류 `%TEMP%\PcManagerRemote.log`
- **PiP**: 아래 모서리 고정(위로 펼침), 더블클릭 접기, 탭 순서 채팅→파일 전송, 화면 밖이면 자동 맞춤, 원격 창·전체화면 위에서도 표시(최상위 층으로 포털)
- **업데이트**: GitHub API 한도 초과 시 웹 리디렉션으로 확인, 설치 기록(`C:\ProgramData\PcManager\Server\install.log`)·실패 표시
- **난독화**: Obfuscar (배포 빌드만)
- 기타: 공유 아이콘(다운로드 링크), PC 트리 들여쓰기·별칭 이름순 정렬
- **채팅방 (0.8.18 이후)**: 전체 채팅을 없애고 PiP 채팅 탭에 왼쪽 방 목록(1:1·그룹) + 오른쪽 대화. 다른 프로젝트 사용자와도 대화.
  그룹은 만들 때 이름 입력, 초대는 구성원 누구나, 강퇴·이름 변경은 방장만(방장이 나가면 가장 먼저 들어온 사람이 방장).
  알림은 '[방 이름] 보낸 사람 | 내용'. 서버: `ChatRoomStore`(chat-rooms.json, chat-room-messages.jsonl), `Api/ChatEndpoints.cs`,
  메시지·변경은 Hub 그룹 `chat:사용자id`로 구성원에게만. 대시보드: `ChatPanel.tsx`, `useDashboard`의 chatRooms/chatActions/subscribeChat.
  예전 전체 채팅(chat.jsonl)은 더 이상 읽지 않음

---

## 3. 꼭 알아야 할 규칙 / 함정

### 난독화 (Obfuscar, `Directory.Build.targets`)
- `build/package.ps1`이 `-p:PcmObfuscate=true`로 게시 (개발 빌드는 난독화 안 함). 도구는 `dotnet-tools.json`.
- **새 서버 API 처리기는 반드시 `PcManager.Server.Api` 네임스페이스에 둘 것** — ASP.NET이 매개변수 이름으로 값을 넣는데 Obfuscar가 매개변수 이름을 지움(서버가 시작조차 안 됨).
- **JSON으로 읽는 비공개 형식**에는 `[System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]` (생성자 매개변수 이름 필요). 익명 형식은 규칙으로 이미 제외(`skipMethods="true"` 필수).
- 난독화 후 시험: `dotnet publish ... -p:PcmObfuscate=true`로 서버·에이전트를 만들어 기존 e2e를 돌릴 것.

### 서버 자가 업데이트
- 설치기는 `DetachedProcess.Start`(숨긴 콘솔)로 실행. **`DETACHED_PROCESS` 쓰지 말 것** (powershell이 아무것도 안 하고 끝남).
- `install-server.ps1`은 BOM 있는 UTF-8 유지(PowerShell 5.1). 진행 기록·실패 시 서비스 재시작(trap) 포함.

### 서비스(SYSTEM) 컨텍스트
- 사용자 파일 연결·문서 폴더·프로그램 실행은 사용자 세션 기준이어야 함 → `SessionProcess.StartAsSessionUser`, `GetUserDocumentsFolder` 등 사용.
- 개발 환경(콘솔 실행)은 사용자 권한이라 서비스 환경 문제를 놓치기 쉬움.

### 릴리스 절차
- `Directory.Build.props` 버전 올림 → 커밋 → push main → `git tag vX && git push origin vX` → GitHub Actions가 빌드·릴리스.
- **릴리스 확인은 GitHub API를 반복 조회하지 말 것** (회사 IP의 비인증 한도 60/시간을 써서 서버 업데이트 확인이 403 남). `https://github.com/choisjin/PC_Manager/releases/latest` 리디렉션을 3분 간격으로 확인.
- push 전에는 항상 사용자 확인 (CLAUDE.md).

### 개발 환경
- 개발 서버 `dotnet run --launch-profile http` (5063), 에이전트 `--launch-profile console`, 대시보드 `web`에서 `npm run dev` (5173).
- 내 PC 프로그램으로 열기 시험 시 에이전트에 `PCM_EDIT_NO_LAUNCH=1` (실제 프로그램 실행 안 함).
- 패키징(`build/package.ps1`)은 `npm ci`로 `node_modules`를 지우므로 **dev 서버(vite)를 끄고** 실행.
- Git Bash 히어독에서 백슬래시가 망가지는 경우가 많음 → 파일 수정은 스크립트 파일(Write)로.
- Node `fs.rmSync`가 한글 경로에서 프로세스를 죽이는 현상 있음(시험 스크립트 작성 시 주의).
- e2e 스크립트(Playwright)는 세션 스크래치 폴더에 있었음 — 새 대화에서는 필요 시 다시 작성.

---

## 4. 남은 일 / 제안

1. **0.8.18 서버 업데이트를 대시보드 버튼으로 확인** (위 1번). 실패하면 업데이트 창 메시지와 `install.log` 내용으로 진단.
2. **저장소 비공개 전환 준비**: 업데이트 확인·서버 zip 다운로드를 GitHub 토큰(`ServerOptions.GitHubToken`)으로 하도록 수정 (비공개면 `browser_download_url`·웹 리디렉션 불가 → API 자산 엔드포인트 + `Accept: application/octet-stream`). 에이전트 설치 파일은 서버가 배포하므로 영향 적음.
3. 보호 수준을 더 올리려면 상용 난독화(.NET Reactor 등) 검토. NativeAOT는 WinForms·EF Core·SignalR 때문에 큰 재작성 필요.
4. 실제 환경 확인: 셸 아이콘(서비스), 원격 로그인 재연결, 엑셀 열기·저장, NAS/도메인 공유 자격증명.
