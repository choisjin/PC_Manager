# HANDOFF — PC Manager ("RemoteKit")

작성: 2026-10-22 · 최신 릴리스 **v0.8.89** (Result 탭 목록화 · 결과 화면 먼저 열기, 아래 1절)
작업 트리: `tools/net/add-lan-ip.ps1`(사용자 개인 네트워크 스크립트, **커밋하지 않음**).

테스트 PC 관리 도구. 웹 대시보드(React, `web/`) + ASP.NET Core 서버 + .NET 에이전트(Windows·Linux) + **서버 런처**.
구조·설계는 `docs/ARCHITECTURE.md`.

실제 운영 환경: 서버 PC `CHRRD11-NA10CR1`, 런처 폴더 `D:\PC_ManagerServers`, 서버 `Nissan`(HTTP 5065 / HTTPS 5066), `Renault`(5067/5068).
**서버 PC는 공유기 안**: 서버 PC LAN IP `192.168.0.204`, 공유기 바깥 주소 `10.176.144.70` → 포트 포워딩.
회사 PC들은 `http(s)://10.176.144.70:5065/5066`으로 접속한다 (서버 PC 네트워크 카드에는 10.176.144.70이 없음).

---

## 1. 지금 상태 (2026-10-22 두 번째 대화)

### 결과 확인 탭: 크롭 이미지가 나타나는 구간 찾기 — **0.8.88로 릴리스**

사용자 요청: 원하는 프레임에서 이미지를 크롭 → 이 실행(Result)의 영상 전부에서 나타나는 구간을 한 타임라인에 표시, 이어서 보이는 구간은 **첫 프레임만**.
검색 방식 (사용자 답): **"지정한 영역에서 지정한 유사도 이상을 찾음"** → 검색 영역(크롭 위치 그대로 · 직접 지정 · 화면 전체) + 유사도 기준(%).

만든 것:
- 에이전트 `src/PcManager.Agent/VideoImageSearch.cs` (Linux 에이전트도 링크 컴파일): ffmpeg `fps=<영상 fps>,[scale=크롭한 영상 크기],crop=검색 영역,format=gray`
  raw 파이프를 프레임마다 읽어 NCC 최댓값 → 프레임별 유사도(0~200 바이트 = 0~100%). 작업 id로 시작·진행 조회·멈춤
  (`AgentClientMethods.StartImageSearch/GetImageSearch/CancelImageSearch`, 2분간 조회가 없으면 스스로 멈춤, 끝난 작업 15분 보관).
  - 넓은 영역: `Matcher`가 1/k로 줄여 전체를 훑고 상위 3곳을 원래 크기에서 다시 맞춤, 그래도 무거우면 Step 프레임마다만 전체 검색하고
    사이 프레임은 직전 위치 ±2 → 새 위치를 찾으면 그 사이 프레임을 그 위치에서 다시 재서 **첫 프레임을 놓치지 않음**.
  - 정수 SIMD 내적, 적분 영상은 위치가 많을 때만. 1080p 60초 기준: 크롭 위치 0.85초, 600×400 영역 4.4초, 화면 전체 6.6초 (testsrc2, 실제 녹화는 디코딩이 더 느림).
  - `VideoTrimmer.Probe`에 영상 크기 추가, `FindFfmpegAsync`·`ProbeAsync`는 internal로.
- 서버 `Api/ResultSetEndpoints.cs`: `POST/GET/DELETE /api/agents/{id}/video/image-search[/{searchId}]` (`CallAgent` 공통 처리).
- 웹: `components/results/imageSearchState.ts`(상태·작업 훅 `useImageSearch`, 구간 나누기) + `ImageSearch.tsx`(`CropOverlay` 영상 위 드래그, `ImageSearchPanel`).
  `ResultViewer.tsx`에 [🔍 이미지 찾기] 버튼·패널(열려 있는 동안 스텝 이미지 칸 대신), `VideoTransport.tsx`에 `overlay`·`marks`(탐색 막대 위 구간).
  템플릿은 브라우저가 지금 프레임을 캔버스로 떼어 회색조로 보냄. 크기가 다른 영상은 크롭한 영상 크기 기준 좌표로 맞춤.
  유사도 기준·끊김 무시(초)는 바꾸면 다시 찾지 않고 바로 다시 나눔. 패널을 닫아도 결과·진행 중인 찾기는 유지, Esc는 그리기 → 패널 순(자르기·저장 창이 열려 있으면 그 창).
- 확인: 로컬 개발 서버+에이전트+Playwright로 640×360·1280×720 영상 2개, 크롭 위치/직접 지정/화면 전체, 첫 프레임 정확(3.000·10.000·15.500초), 영어 화면.

남은 일: 서버·**에이전트 업데이트 필요**(옛 에이전트면 "에이전트 호출 실패 (에이전트를 업데이트하세요)").
실제 회사 녹화 영상(압축 잡음)에서 유사도가 얼마나 나오는지 사용자 피드백 받기 (기본 기준 90%).

### 0.8.89: Result 탭 목록화 · 결과 화면 먼저 열기 + 받는 속도·남은 시간

- Result 탭(`ResultsPage.tsx`): 날짜 입력·달력·날짜 버튼과 [경로 확인 후 열기]를 없앰. 그 PC의 Result 파일 전부를 **왼쪽 목록**(최신순, 이름 · 시각 · 크기 · 하위 폴더),
  고른 파일 정보(실행 시작·마지막 기록·크기·위치·찾은 영상/이미지 폴더)와 [열기]는 **오른쪽**. 두 번 누르면 엽니다.
- 결과 화면(`resultSessions.ts`, `ResultViewer.tsx`): 불러오기를 시작하자마자 화면을 연다(`openViewer`가 loading도 허용, failed만 막음).
  머리글 아래 `LoadingBar`, 영상 자리 `VideoWaiting`에 `ProgressLine`(무엇 · % · 받은 양/전체 · 속도 · 남은 시간). 불러오는 중 [저장]은 막음.
  - Result 받기: `readWithProgress`(Content-Length 기준), 속도는 `RateMeter`(0.5초 넘는 표본 지수 평활).
  - 영상 준비: 에이전트 `VideoTrimmer.GetProgress` ← ffmpeg `-progress pipe:1`(out_time/길이, 길이를 모르면 쓴 크기/원본 크기) · 서버에서 ffmpeg 받는 진행.
    서버 `GET /api/agents/{id}/video/prepare/progress?path=`(진행 없으면 204), 웹이 1초마다 물음(옛 에이전트면 조용히 그만).
  - 영상은 여전히 하나씩 준비 → 차례를 기다리는 영상은 `prep: 'waiting'`("앞 영상을 준비한 뒤 …").
- 확인: 400 KB/s 제한에서 4.2 MB Result가 ~390 KB/s · 남은 시간 0:10→0:01, 1080p HEVC mkv 변환 60% · 34 MB/s · 0:03, 새 탭은 0.1초 만에 화면이 뜸.

### 취소된 작업 (사용자 결정, 2026-10-22)
에이전트 접속 주소를 인증서에 자동으로 넣기 · 런처 자체 업데이트 — 하지 않기로 함. (런처 [인증서 추가 주소…]로 손으로 넣는 방식 유지)

---

## 2. 이번 대화에서 만든 것 (0.8.82 → 0.8.87)

- **0.8.82 Result 탭 ATS 설정**: ATS는 설치 드라이브 + 영상 폴더만 고름. Result = `<드라이브>\excelrunner_report\<날짜 폴더>\*.csv`
  (Result 폴더 바로 안 + 날짜 이름 폴더 바로 안만, 하위는 안 봄), 원본 이미지 = `excelrunner_report\captured_image`,
  결과 이미지 = 그 날짜 폴더 안 이미지가 든 하위 폴더 (`resultFinder.ts` `listResultFiles`/`findImageDir`, `ResultsPage.tsx` `ProfileForm`).
- **0.8.83** (다른 세션 작업을 같이 커밋): 결과 폴더 프리셋, 설치형 서버 HTTPS 인증서 자동 재발급(`Services/InstalledCertificate.cs`), Linux 에이전트 런처 창.
- **0.8.84 런처 인증서 감시**: 런처가 네트워크 주소 변경(15초 뒤)·1시간마다 인증서 확인 → 새로 만들면 HTTPS 서버 재시작 + 트레이 알림 (`MainForm.RenewCertificateAsync`).
- **0.8.85 HTTPS 기본**: `web/src/https.ts` — HTTP로 열리면 HTTPS 주소에 `no-cors` 요청을 보내 되면(인증서 신뢰) 같은 경로 HTTPS로 이동,
  localStorage를 `#pcm-migrate=` 뒤에 실어 넘김(HTTPS 쪽 값은 안 덮음, `?http`면 이동 안 함). 안 되면 `HttpsBanner.tsx` 안내 띠.
  Windows 에이전트 `ServerCertificateTrust`는 BackgroundService로 연결 중 10분마다 서버 .cer를 받아 신뢰 저장소 확인.
- **0.8.86 에이전트 설치 안내**: 접속 PC(IP·`?pc=` 이름)에 에이전트가 없으면 로그인 전 `AgentInstallGate.tsx`.
  에이전트가 연결되면 5초 뒤 새로 고침 → HTTPS로 이동. "에이전트 없이 계속"(안 되는 기능 안내, `pcm.noAgent` 기억, `?noagent`).
  제외: 서버 PC에서 연 경우(clientIp null), Windows/Linux 아닌 기기, 결과/원격조작 탭, 개발 모드.
- **0.8.87 인증서 주소**: 런처 [인증서 추가 주소…](`CertificateHostsDialog.cs`, `launcher.json`의 `CertificateHosts`),
  런처·설치형 모두 "이 PC가 가진 IP가 하나라도 인증서에 없으면 재발급"(169.254.* 제외).

## 3. 잘 된 방법
- 원인 진단: 사용자 스크린샷의 인증서 주체 `PC Manager Server (PC이름)` = 런처 인증서, `PC Manager Server` = 설치형.
- 등록돼 있지만 꺼진 옛 에이전트가 있으면 설치 안내가 안 뜸 → 목록에서 삭제하니 정상. (꺼진 에이전트도 '설치됨'으로 보는 현재 규칙)
- 여러 줄 TS 수정은 Python 패치 스크립트를 **Write로 파일을 만든 뒤** 실행(문자열 일치 assert 후 치환).

## 4. 안 된 방법 (반복하지 말 것)
- 0.8.84에서 런처 인증서 재발급 기준을 "기본 경로 IP만"으로 바꿈 → 네트워크 카드 둘·포트 포워딩 환경에서 경고 지속. 0.8.87에서 되돌림.
- Git Bash 히어독 안에서 Python으로 `\\` 들어간 문자열 치환 → 백슬래시가 반으로 줄어듦. 스크립트 파일로 쓸 것.
- 이 PC(IDEALITY)에서 회사망 서버(10.176.x)로 curl 불가 → 원격 진단은 사용자에게 화면·주소 결과를 받아야 함.

---

## 5. 꼭 알아야 할 규칙 / 함정

### 릴리스 절차
- `Directory.Build.props` 버전 올림 → 커밋(한국어, 기존 커밋처럼 접두어 없는 상세 문장 + `· 버전 x.y.z`) → push main →
  `git tag vX && git push origin vX` → Actions가 빌드·릴리스(서버 zip, 에이전트 Setup exe, Linux 에이전트, 런처 exe).
- push 전 사용자 확인(CLAUDE.md). 사용자가 "커밋 푸시 릴리즈까지 진행해"라고 하면 그 범위만큼 진행.
- **릴리스 확인은 GitHub API 반복 조회 금지** (회사 IP 한도). `gh run list` 한두 번 정도.
- 다른 세션이 같은 작업 트리에서 일할 수 있음 → 커밋할 파일을 하나씩 지정, `tools/net/`은 빼기.
- 대시보드(web)·서버 변경 = 서버 릴리스 → 런처 [일괄 업데이트]로 반영. **런처 코드 변경은 exe 직접 교체 필요**(자체 업데이트 없음).

### 난독화 (Obfuscar, `Directory.Build.targets`)
- 새 서버 API 처리기는 `PcManager.Server.Api` 네임스페이스에. JSON으로 읽는 비공개 형식에는 `[System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]`.

### 서버 실행 방식
- 설치형(서비스 `PcManagerServer`, 인증서 `CN=PC Manager Server`, `InstalledCertificate`가 재발급) vs 포터블(런처 `--port/--https-port/--cert`,
  인증서 `https\PcManager-Server.pfx`, 런처 `ServerCertificate`가 재발급, 서버는 시작할 때만 인증서를 읽음 → 재발급 후 재시작 필요).
- 키보드 잠금·WebCodecs는 보안 컨텍스트(HTTPS) 필요, 키보드 잠금은 최상위 문서만.

### 개발 환경
- 서버 `dotnet run --launch-profile http`(5063), 대시보드 `web`에서 `npm run dev`(5173). 웹 확인: `npx tsc -b`, `npx oxlint <파일>`.
- 개발 모드(`import.meta.env.DEV`)에서는 HTTPS 이동·에이전트 설치 안내가 꺼짐 → 실제 확인은 패키지 서버로.
- 한국어 화면 문구를 새로 넣으면 `web/src/i18n/en.ts`에 영어도 추가(EXACT 또는 `{0}` TEMPLATES).
