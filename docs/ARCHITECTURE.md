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

### 원격조작
- 캡처: DXGI Desktop Duplication
- 인코딩: Media Foundation H.264 하드웨어 인코더
- 전송: WSS 서버 릴레이 → 브라우저 WebCodecs 디코딩 (추후 WebRTC P2P 확장)
- 입력: 브라우저 이벤트 → `SendInput`
- 목록은 저프레임 썸네일, 열린 원격 창만 고화질 스트리밍

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
4. 원격 화면/제어 (H.264 스트리밍)
5. 인증/권한/감사 로그, 설치 패키지 — 부분 완료 (무인증 설치·자동 업데이트는 구현, 인증/권한은 미구현)

## 업데이트 (0.2.3+)
- 서버가 GitHub 릴리스 API로 최신 버전·릴리스노트 확인 (UpdateService, 주기적 + 수동)
- 서버 자가 업데이트: 새 패키지 다운로드 → install-server.ps1 실행 → 서비스 재시작 (LocalSystem 필요)
- 에이전트 업데이트: 서버가 UpdateAgent 명령 → 에이전트가 설치 파일 받아 --install --silent 재설치
