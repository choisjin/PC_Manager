# PC Manager

자동화 검증용 테스트 PC 관리 도구. 설계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 참고.

## 요구 사항

- .NET 10 SDK
- Node.js 20 이상

## 개발 실행

터미널 3개에서 각각 실행한다.

```sh
# 1. 서버 (http://localhost:5063)
dotnet run --project src/PcManager.Server

# 2. 에이전트 (같은 PC에서 테스트)
dotnet run --project src/PcManager.Agent.Service

# 3. 대시보드 (http://localhost:5173)
cd web
npm run dev
```

개발 환경에서는 서버와 에이전트 모두 `dev-agent-token` 토큰을 사용한다.

## Job과 결과 수집

대시보드 **Job** 탭에서 대상 PC(직접 선택 또는 태그)와 단계를 정해 실행한다.

- 단계 종류: `명령 실행`, `결과 수집`
- PC 안에서는 단계를 순서대로, PC 사이는 `동시 실행 PC 수`만큼 병렬로 실행
- 단계가 실패하면 그 PC는 멈춘다. `실패해도 다음 단계 진행`을 켜면 계속 진행하되 결과는 실패로 남는다

명령에는 다음 환경 변수가 전달된다.

| 변수 | 내용 |
|---|---|
| `PCM_RESULT_DIR` | 결과 파일을 저장할 폴더. `결과 수집` 단계의 기본 대상 (같은 Job의 단계끼리 공유) |
| `PCM_JOB_RUN_ID` | Job 실행 ID |
| `PCM_RUN_ID` | 명령 실행 ID |

```bat
pytest --junitxml=%PCM_RESULT_DIR%\junit.xml
```

수집된 JUnit XML은 PC별 통과/실패/건너뜀으로 집계된다. 결과 파일은 서버 `src/PcManager.Server/App_Data/artifacts`에 저장된다.

## 파일 탐색기

**파일 탐색기** 탭에서 온라인 PC의 폴더를 탐색하고, 파일을 서버로 가져와 다운로드하거나 PC로 올릴 수 있다.

## 다른 PC의 에이전트 연결

서버를 외부에서 접속 가능하게 실행하고 방화벽에서 포트를 허용한다.

```sh
dotnet run --project src/PcManager.Server --urls http://0.0.0.0:5063
```

테스트 PC의 에이전트 `appsettings.json`:

```json
"Agent": {
  "ServerUrl": "http://<서버 IP>:5063",
  "Token": "<서버의 Server:AgentToken>",
  "Tags": ["gui-test", "site:seoul"]
}
```

## 에이전트를 Windows 서비스로 설치

관리자 권한 PowerShell에서 실행한다.

```powershell
dotnet publish src/PcManager.Agent.Service -c Release -r win-x64 --self-contained -o C:\PcManager\Agent
sc.exe create PcManagerAgent binPath= "C:\PcManager\Agent\PcManager.Agent.Service.exe" start= auto
sc.exe start PcManagerAgent
```

- AgentId와 기본 작업 폴더: `C:\ProgramData\PcManager\Agent`
- 서비스는 SYSTEM 계정·Session 0에서 실행되므로 **GUI 테스트는 아직 실행할 수 없다** (3단계 세션 에이전트에서 지원)

## 운영 서버 설정

`Server:AgentToken`이 비어 있으면 서버가 시작되지 않는다.

```sh
set Server__AgentToken=<충분히 긴 임의 문자열>
```

> 1단계에는 대시보드 로그인이 없다. 신뢰할 수 있는 내부망에서만 사용할 것 (5단계에서 인증/권한 추가).
