# PC Manager

자동화 검증용 테스트 PC 관리 도구. 여러 테스트 PC에 명령과 Job을 일괄 실행하고, 결과 파일을 수집하고, PC와 파일을 주고받는다. 설계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 참고.

## 설치 (실사용 환경)

.NET이나 Node.js를 설치할 필요가 없다. Windows 10/11, Windows Server 2019 이상 (x64).

1. **패키지 준비**: [Releases](https://github.com/choisjin/PC_Manager/releases)에서 `PcManager-Server-<버전>.zip`을 받는다. (또는 아래 [배포 패키지 만들기](#배포-패키지-만들기))
2. **서버 설치**: 서버로 쓸 PC에서 zip을 풀고, 그 폴더에서 관리자 PowerShell로 실행한다.
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-server.ps1
   ```
   서비스 등록, 방화벽 허용까지 자동으로 처리하고 대시보드 주소를 알려준다. (에이전트는 서버 주소만으로 연결, 인증 없음)
3. **테스트 PC 추가**: 대시보드 왼쪽 **+ PC 추가** → **설치 파일 다운로드** → 테스트 PC로 옮겨 더블클릭한다.
   보안 경고에서 [예](관리자 권한)를 누르면 서비스와 트레이 런처가 설치되고, 열리는 런처 창에 **서버 주소**를 입력하고 [연결]을 누른다. 몇 초 뒤 대시보드에 PC가 온라인으로 표시된다.

에이전트 트레이 런처로 연결/끊기, 서버 주소 변경, 업데이트, 연결 상태 확인을 할 수 있다. 관리자 권한은 최초 설치 때 한 번만 필요하다.

업그레이드는 서버는 새 패키지로 같은 과정을 반복하고(DB·결과 파일 유지), 에이전트는 새 설치 파일을 다시 더블클릭하거나 런처의 업데이트 알림에서 갱신한다. 자세한 내용은 [서버 설치 안내](installer/server/README.txt) 참고.

### 대시보드에서 업데이트

서버가 인터넷에 연결돼 있으면 대시보드 오른쪽 위 버전 칩에서 **최신 릴리스와 릴리스노트를 확인**하고 버튼으로 바로 적용할 수 있다.

- **서버 업데이트**: 서버가 GitHub에서 새 패키지를 내려받아 자동 설치·재시작한다. (서버 서비스가 LocalSystem으로 실행돼야 하며, 0.2.3 이상부터 지원)
- **에이전트 업데이트**: 서버보다 구버전인 온라인 PC에 업데이트를 지시하면, 각 PC가 서버에서 설치 파일을 받아 스스로 갱신한다(관리자 조작 불필요).

> 자동 업데이트는 **0.2.3부터** 동작한다. 기존 서버·에이전트를 0.2.3으로 올리는 첫 단계는 수동(서버 재설치, 에이전트 더블클릭)이고, 이후 버전부터 대시보드 버튼으로 갱신된다.

| 구성 | 프로그램 | Windows 서비스 | 설정·데이터 |
|---|---|---|---|
| 서버 + 대시보드 | `C:\Program Files\PcManager\Server` | `PcManagerServer` (LocalService) | `C:\ProgramData\PcManager\Server` |
| 에이전트 | `C:\Program Files\PcManager\Agent` | `PcManagerAgent` (LocalSystem) + 트레이 런처 | `C:\ProgramData\PcManager\Agent` |

> **주의**
> - 대시보드 로그인이 아직 없고, 에이전트도 서버 주소만으로 연결된다. 신뢰할 수 있는 내부망에서만 사용한다. (5단계에서 인증 추가 예정)
> - 에이전트는 SYSTEM 계정 서비스로 실행되므로 GUI 자동화 테스트는 아직 지원하지 않는다. (3단계)

## 사용법

### 명령 실행

**명령 실행** 탭에서 PC를 골라 CMD/PowerShell 명령을 한꺼번에 실행하고 출력을 실시간으로 본다.

### Job과 결과 수집

**Job** 탭에서 대상 PC(직접 선택 또는 태그)와 단계를 정해 실행한다.

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

수집된 JUnit XML은 PC별 통과/실패/건너뜀으로 집계된다.

### 파일 탐색기

**파일 탐색기** 탭에서 온라인 PC의 폴더를 탐색하고, 파일을 서버로 가져와 다운로드하거나 PC로 올린다.

영상 파일(🎬)은 클릭하면 **서버에 옮기지 않고 바로 스트리밍**으로 재생된다(구간 탐색 지원). 브라우저가 못 여는 형식(MKV·AVI, HEVC 등)은 "원본 가져와 다운로드"로 안내한다.

## 개발

### 요구 사항

- .NET 10 SDK
- Node.js 20 이상

### 실행

터미널 3개에서 각각 실행한다. 개발 환경에서는 인증 없이 `localhost`로 붙는다.

```sh
# 1. 서버 (http://localhost:5063)
dotnet run --project src/PcManager.Server

# 2. 에이전트 (같은 PC에서 콘솔 모드로 테스트)
dotnet run --project src/PcManager.Agent -- --console

# 3. 대시보드 (http://localhost:5173)
cd web
npm run dev
```

### 배포 패키지 만들기

PowerShell 7.3 이상에서 실행한다.

```powershell
pwsh build/package.ps1              # 버전: Directory.Build.props
pwsh build/package.ps1 -Version 0.3.0
```

`artifacts/`에 두 파일이 만들어진다.

- `PcManager-Server-<버전>.zip`: 서버, 대시보드, 에이전트 설치 파일, 설치 스크립트
- `PcManager-Agent-Setup-<버전>.exe`: 테스트 PC용 더블클릭 설치 파일 (단독 배포용, 서버 패키지에도 내장됨)

에이전트는 단일 실행 파일 하나로 설치·서비스·트레이 런처를 모두 담당한다 (`--install`/`--uninstall`/`--service`/`--launcher`).

GitHub에 `v*` 태그를 push하면 Actions가 패키지를 빌드해 Releases에 올린다.

```sh
git tag v0.2.0
git push origin v0.2.0
```

설치 스크립트 원본은 `installer/`에 있다. Windows PowerShell 5.1에서 한글이 깨지지 않도록 UTF-8 BOM으로 저장한다.
