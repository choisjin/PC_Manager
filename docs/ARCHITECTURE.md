# PC Manager 아키텍처

자동화 검증용 테스트 PC 관리 도구. 여러 망/원격지의 테스트 PC를 원격조작하고, 일괄 작업을 실행하며, 결과 데이터를 수집/관리한다. 테스트 실행 중에는 물리 입력을 잠근다.

## 구성

```
[웹 대시보드 (React + TypeScript)]
        │ HTTPS / SignalR
[관리 서버: ASP.NET Core]
  - REST API, SignalR Hub, 화면 스트림 릴레이
  - DB: SQLite (추후 PostgreSQL)
  - 결과 저장소: 파일시스템 (추후 MinIO/S3)
        ▲  에이전트가 서버로 먼저 접속 (WSS + TLS) → NAT/방화벽 통과
        │
[테스트 PC]
  ├─ PcManager.Agent (단일 exe, 여러 모드)
  │    --service  : Windows Service (SYSTEM). 서버 연결, 명령/Job/파일 전송, 세션에 런처 실행
  │    --launcher : 트레이 런처 (로그인 사용자 세션). 연결/끊기/서버주소/업데이트/상태
  │    --install / --uninstall : 더블클릭 설치기 (UAC 승격, 서비스 등록)
  │    --remote-session <url> : 원격조작 프로세스 (서비스가 콘솔 세션에 SYSTEM 권한으로 띄움, 보는 사람마다 1개)
  │    서비스 ↔ 런처는 named pipe로 통신 (LocalControl)
  └─ (예정) 세션 에이전트: 화면 캡처, 입력 주입, 입력 잠금, GUI 테스트 실행
```

서비스는 Session 0에서 실행되어 화면/입력에 접근할 수 없으므로, 세션 에이전트를 사용자 세션에 띄워 역할을 나눈다.

## 프로젝트

| 경로 | 역할 |
|---|---|
| `src/PcManager.Shared` | 서버-에이전트 공통 메시지 계약 |
| `src/PcManager.Server` | ASP.NET Core API + SignalR Hub |
| `src/PcManager.Agent.Service` | 테스트 PC 상주 에이전트 (Windows Service) |
| `src/PcManager.Agent.Session` | 세션 에이전트 (화면/입력/잠금) — 3단계 |
| `web` | 대시보드 |

## 요구사항별 설계

### 원격조작 (구현: `src/PcManager.Agent/Remote`, `Api/RemoteEndpoints.cs`, `web/src/components/remote`)
- 흐름: 브라우저 WS `/api/agents/{id}/remote` → 서버가 세션 ID 발급 후 에이전트에 `StartRemote` → 서비스가 콘솔 세션에 원격조작 프로세스 실행 → 그 프로세스가 WS `/api/agent/remote/{sessionId}`로 접속 → 서버가 두 소켓을 그대로 중계
- 원격조작 프로세스는 서비스의 SYSTEM 토큰을 복제해 세션만 바꿔 실행 → 입력 데스크톱(Default/Winlogon)을 따라가며 UAC 확인 창·잠금/로그인 화면도 캡처/조작
- 캡처: DXGI Desktop Duplication (실패 시, 또는 3초간 프레임이 없으면 GDI BitBlt). 바뀐 화면만 인코딩, 최대 30fps
- 해상도 맞춤(기본 켜짐): 대시보드 PC 모니터 해상도에 맞춰 원격 디스플레이 모드를 바꾼다 (`DisplayModes`, ChangeDisplaySettingsEx, 레지스트리 미저장, 세션 종료 시 복원).
  같은 크기 → 같은 화면비 중 최대 → 가로세로 모두 작은 것 중 최대 순으로 고르며, 지원 모드가 없으면 안내만 하고 원래 해상도로 진행
- 스트림은 그 위에서 대시보드 화면 영역 크기(`view`)에 맞춰 줄여 인코딩 (가로세로 비 유지, 원본보다 크게는 안 함). 창 크기가 바뀌면 다시 맞춘다
- 세션 선택: 활성(WTSActive) 세션 우선(로그인 전이면 콘솔=로그인 화면). 대상이 RDP면 tscon으로 콘솔에 붙여 원격조작이 RDP보다 우선하도록 한다
- 로그인·잠금·UAC 등 데스크톱 전환 중 캡처 예외가 나도 세션을 끊지 않고 캡처 장치만 다시 만든다
- 헤드리스 PC: 가상 모니터는 원격조작·썸네일 모두 `VirtualDisplay.EnsureForHeadless`로 준비하며, 한 번 켜면 끄지 않는다 (화면이 없으면 캡처가 검게 나오고 GUI 테스트도 안 됨)
- 인코딩: Media Foundation H.264 소프트웨어 MFT (Baseline, 저지연, B 프레임 없음, CBR). BGRA→NV12(BT.709)는 CPU 병렬 변환, 폭 2560 초과면 1/2 축소
- 디코딩: 보안 컨텍스트(HTTPS/localhost)면 WebCodecs → canvas, 아니면(http://서버IP) 브라우저에서 fMP4로 감싸 MSE → video
- 입력: 브라우저 KeyboardEvent.code → 스캔 코드 `SendInput` (원격 PC의 배열/IME 적용), 마우스는 모니터 기준 0~1 좌표. Ctrl+Alt+Del은 서비스가 `SendSAS` (SoftwareSASGeneration 정책을 켬)
- 키 입력은 이벤트마다 수식 키 상태를 함께 보내고, 에이전트가 주입 직전에 원격 수식 키를 맞춘다 (Shift+숫자 등 유실/순서 보정)
- 로컬에서 가로채는 특수 키(Ctrl+Alt+Del, Win, Alt+Tab…)는 아이콘 버튼으로 전송. 창 모드는 상단바, 전체 화면은 반투명 PiP
- 전체 화면 + Keyboard Lock API(HTTPS 필요)면 Ctrl+Alt+Del을 뺀 특수 키를 직접 눌러도 원격으로 간다
- HTTPS: 설치 스크립트가 자체 서명 인증서(SAN: 호스트명·IPv4·localhost)를 LocalMachine\My에 만들고 Kestrel HTTPS 포트(기본 5064)를 연다.
  신뢰는 자동: 서버는 시작 시(`Program.cs`), 에이전트는 등록 시(`ServerCertificateTrust`) `CertificateTrust.EnsureTrustedRoot`로 LocalMachine\Root에 넣는다.
  에이전트 없는 PC는 `/api/install/PcManager-인증서-설치.cmd`(자체 승격 배치)로 한 번 설치. 에이전트 통신 자체는 HTTP 그대로
- 썸네일(Remote 모드): 서버 `ThumbnailService`가 보는 대시보드가 있는 PC마다 에이전트에 `--remote-session <url> --thumb` 프로세스를 띄워
  3초마다 320px JPEG + "움직임 없는 시간"(작업 표시줄 제외 회색조 비교)을 받고 SignalR `ThumbnailUpdated`로 뿌린다. 아무도 안 보면 10초 뒤 종료
- PC 상태: 수동 상태(테스트 중/사용 금지/점검 중, `PcStatusStore`)와 실시간 원격 사용 중(`RemoteUsageRegistry`). 사용 금지·타인 사용 중이면 원격 차단
- 채팅: `DashboardHub.SendChat` → `ChatStore`(chat.jsonl) → `ChatMessage` 브로드캐스트. 전송 PiP의 채팅 탭
- 메시지 형식은 `RemoteSessionApp.cs` 주석 참고
- 추후: 하드웨어 인코더(비동기 MFT), 커서 모양, 클립보드 동기화, 오디오, WebRTC P2P

### 일괄 동작
- Job = Step 목록 (명령 실행, 파일 배포, 잠금, 재부팅 대기, 결과 수집)
- 대상: 태그/그룹 (`gui-test`, `site:busan`)
- 동시 실행 수 제한, 타임아웃, PC별 재시도, 실시간 로그
- 서비스가 진행 상태를 로컬에 저장해 재부팅 후 다음 Step부터 재개

### 결과 데이터
- 규약 폴더(`runs/{runId}/`) 자동 업로드 + 메타데이터(PC, exit code, 시간, 태그) DB 인덱싱
- JUnit XML / pytest 결과 파싱 → pass/fail 집계
- 원격 파일 탐색기 (임의 경로 다운/업로드)
- REST API로 CI/분석 스크립트 연동

### 테스트 중 입력 잠금
- 저수준 키보드/마우스 훅으로 물리 입력만 차단, `LLKHF_INJECTED`/`LLMHF_INJECTED` 입력(테스트 도구, 원격조작)은 통과
- 화면을 덮지 않는 클릭 통과 배너 (`WS_EX_TRANSPARENT | WS_EX_LAYERED`)
- `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`로 테스트 스크린샷에서 배너 제외
- 해제: 서버 명령 / Job 종료 시 자동 / 현장 비상 해제(관리자 PIN)
- 한계: Ctrl+Alt+Del은 차단 불가 → 세션 잠금 감지 후 서버 보고
- HW 테스트의 USB HID 에뮬레이터는 물리 입력으로 인식 → Raw Input 장치별 허용 목록 필요
- GUI 테스트 PC는 자동 로그온, 절전/화면 잠금 방지 필요

### 원격지 / 보안
- Wake-on-LAN은 망을 넘지 못함 → 같은 망의 켜진 에이전트가 매직 패킷 대리 전송
- 현재는 내부망 무인증(서버 주소만으로 연결). 인터넷 노출 시 등록 토큰, TLS, 역할 기반 권한, 감사 로그 필요 (5단계)

## 개발 단계

1. 에이전트 등록·연결, PC 목록/온라인 상태, 원격 명령 실행 + 실시간 로그 — 완료
2. 일괄 Job, 결과 수집/조회, 원격 파일 탐색기 — 완료 (재부팅 후 재개는 미구현: 서버가 Job 진행을 메모리로 관리)
3. 세션 에이전트 + 테스트 중 입력 잠금
4. 원격 화면/제어 (H.264 스트리밍) — 완료 (소프트웨어 인코더, 하드웨어 가속은 미구현)
5. 인증/권한/감사 로그, 설치 패키지 — 부분 완료 (무인증 설치·자동 업데이트는 구현, 인증/권한은 미구현)

## 업데이트 (0.2.3+)
- 서버가 GitHub 릴리스 API로 최신 버전·릴리스노트 확인 (UpdateService, 주기적 + 수동)
- 서버 자가 업데이트: 새 패키지 다운로드 → install-server.ps1 실행 → 서비스 재시작 (LocalSystem 필요)
- 에이전트 업데이트: 서버가 UpdateAgent 명령 → 에이전트가 설치 파일 받아 --install --silent 재설치
