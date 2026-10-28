# HANDOFF — PC Manager ("RemoteKit")

작성: 2026-10-28 · 최신 릴리스 **v0.9.10** (PC 목록 폴더 권한 — Setting › 인원 권한 › PC 폴더) — **서버 업데이트**, 아래 1절의 0.9.10 항목.
그 앞 0.9.9: 이미지 찾기 유사도 = 밝기 SSIM × 색 · 홀수 크기 검색 영역 · 크롭 표시는 바깥 테두리(서버 + 에이전트),
0.9.8: 깜박임 = 떨어지는 구간 0.15초 · ATS 머리말 줄 수 · 프로젝트별 검출 기준값 · 메모 구간 · 사이드메뉴 탭 · Result PC 트리 · 메모 새 탭(서버만),
0.9.7: 꺼짐 판정 1차 밝기 → 2차 윤곽 → 길이 · 기준 Cycle 대비 이상 판정·화면 깨짐(서버 + 에이전트 — 화면 깨짐은 에이전트 0.9.7의 축소 이미지),
0.9.6: 깜박임 2초·검은 화면(웹), 0.9.5: 그래프 [▶ 따라가기]·ATS Cycle 열 자동(웹), 0.9.4: 끊긴 Cycle에도 제외 구간(웹), 0.9.3: GPU 디코딩 실패를 영상 단위로(에이전트), 0.9.2: NVIDIA cuvid, 0.9.1: 동시 ffmpeg 수,
0.9.0: GPU 고르기. 버전은 0.9.x)
작업 트리: `tools/net/add-lan-ip.ps1`(사용자 개인 네트워크 스크립트, **커밋하지 않음**)만 남음.

테스트 PC 관리 도구. 웹 대시보드(React, `web/`) + ASP.NET Core 서버 + .NET 에이전트(Windows·Linux) + **서버 런처**.
구조·설계는 `docs/ARCHITECTURE.md`.

실제 운영 환경: 서버 PC `CHRRD11-NA10CR1`, 런처 폴더 `D:\PC_ManagerServers`, 서버 `Nissan`(HTTP 5065 / HTTPS 5066), `Renault`(5067/5068).
**서버 PC는 공유기 안**: 서버 PC LAN IP `192.168.0.204`, 공유기 바깥 주소 `10.176.144.70` → 포트 포워딩.
회사 PC들은 `http(s)://10.176.144.70:5065/5066`으로 접속한다 (서버 PC 네트워크 카드에는 10.176.144.70이 없음).

---

## 1. 지금 상태 (2026-10-22 두 번째 대화 ~ 10-23)

### 결과 확인 탭: 크롭 이미지가 나타나는 구간 찾기 — **0.8.88로 릴리스**

사용자 요청: 원하는 프레임에서 이미지를 크롭 → 이 실행(Result)의 영상 전부에서 나타나는 구간을 한 타임라인에 표시, 이어서 보이는 구간은 **첫 프레임만**.
검색 방식 (사용자 답): **"지정한 영역에서 지정한 유사도 이상을 찾음"** → 검색 영역(크롭 위치 그대로 · 직접 지정 · 화면 전체) + 유사도 기준(%).

만든 것:
- 에이전트 `src/PcManager.Agent/VideoImageSearch.cs` (Linux 에이전트도 링크 컴파일): ffmpeg `fps=<영상 fps>,[scale=크롭한 영상 크기],crop=검색 영역,format=gray`
  raw 파이프를 프레임마다 읽어 NCC 최댓값 → 프레임별 유사도(0~200 바이트 = 0~100%) (**0.9.9부터** yuv420p · 밝기 SSIM × 색 — 아래 0.9.9 절). 작업 id로 시작·진행 조회·멈춤
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

### 0.8.90: 영상 바로 재생 · 변환은 승인 후 · 저장 공간 관리

사용자 질문 "로컬처럼 빠르고 어디서나 보는 근본 해결은?" → 느린 원인은 재생 전 mkv 전체 변환이었다.
**최신 Chrome은 길이·탐색 색인(Cues)이 있는 mkv(H.264/AAC, OBS 녹화)를 그대로 재생·탐색**한다 (시험: 2분 mkv 95초 이동 0.15초).
- 에이전트 `VideoTrimmer.PrepareAsync`: 형식·코덱·소리(mkv는 aac/opus/vorbis/mp3/flac)·길이·Cues가 맞으면 **원본 그대로**(PlayPath = 원본).
  Cues는 `ffmpeg -i`로 알 수 없어 `MatroskaIndex.HasCues`가 파일을 직접 읽는다 (SeekHead → Cues 위치 확인 → 앞쪽 Cues → 끝 8MB에서 Cues+CuePoint).
  안 되면 `Reason`(왜) · `Note`(무엇을: 색인 넣은 사본 / H.264 다시 인코딩) · `Transcode` · 원본 크기 · 사본 드라이브와 남은 공간을 돌려준다.
- **변환은 사용자가 승인해야**: 웹 `RawVideo.prep = 'needs-convert'` → 영상 자리 `VideoWaiting`에 까닭·변환 내용·사본 크기/남은 공간과
  [변환 시작] [변환이 필요한 영상 n개 모두 변환] [변환 없이 원본 재생] (`convertVideo`, `playOriginal`, `ORIGINAL_NOTE`). 영상 목록에 "(변환 필요)".
  변환 전 남은 공간 확인(원본 크기 + 512MB). webm 출력이면 소리는 opus/vorbis만 복사, 아니면 libopus.
- **사본 자동 삭제 없앰** (사용자가 직접 관리): 실패해 남은 `.part`만 하루 뒤 정리. `video-cache/index.json` = 사본 → 원본 경로.
- Result 탭 `VideoStorage.tsx`: 드라이브별 남은/전체 공간(막대) · 재생용 사본 목록(원본·크기·마지막 사용) · 선택/모두 삭제.
  에이전트 `GetVideoStorage`/`DeleteVideoCache`, 서버 `GET /api/agents/{id}/video/storage`, `POST …/video/cache/delete`.
- 원본 교체(변환 후 원본 삭제)는 **하지 않기로 보류** (바로 재생으로 변환 자체가 드물어짐).
- 옛 에이전트: 늘 '변환 필요'로 나오고 [변환 시작]·[원본 재생]은 그대로 동작, 저장 공간은 "에이전트를 업데이트하세요".

### 0.8.91: PC 정보 패널 (PC 목록 아래)

사용자 요청: PC를 고르면 PC 목록 사이드바 아래 정보창에 시스템 정보 · 디스크 용량 · 프로세스 · 성능 · 장치 관리자. 테스트 PC 부하를 물어 재 보고 진행.
- 대상 PC = **활성 탐색 창의 PC** (아직 누른 창이 없으면 마지막에 연 창, 공유 서버 창이면 없음). 트리에서 그 PC를 강조(`info-target`).
- 웹 `components/explorer/PcInfoPanel.tsx`(패널·[크게 보기] `<dialog>`·탭별 화면) + `pcInfo.ts`(`usePcInfo`, 문제 코드 설명).
  `PcTree`의 `infoPanel`·`infoAgentId` 속성, `FileExplorer`가 넘긴다. 접기·탭·높이(위 가장자리 끌기)는 localStorage.
  보기만 함 (프로세스 끝내기·장치 사용 안 함은 넣지 않음).
- **부하**: 보고 있는 탭만, 패널을 펼쳤을 때만, 브라우저 탭이 보일 때만 묻는다 (시스템·디스크 30초 · 프로세스 2초 · 성능 1초 · 장치는 열 때/새로 고침).
  에이전트 `SystemMonitor`: 성능은 첫 요청에 1초 측정을 시작해 **10초 동안 요청이 없으면 멈춤**(최근 60개 보관, 여러 명이 봐도 한 번), 프로세스는 1.5초 안이면 저번 목록.
  이 PC(24코어·프로세스 456개)에서 잰 1회 CPU: 성능 0.75ms · 프로세스 6ms · 장치 76ms(열 때만) · 메모리 +약 12MB.
  `NetworkInterface.GetAllNetworkInterfaces()`는 1회 22ms라 30초마다만 다시 읽음.
- 에이전트: `SystemMonitor.cs`(공통, Linux 링크) + `SystemMonitor.Windows.cs`(레지스트리 · `NtQuerySystemInformation`(보호된 프로세스도 CPU 시간) ·
  PDH 영어 카운터(디스크 _Total 읽기/쓰기·가장 바쁜 디스크 활성, GPU Engine 엔진별 합의 최댓값) · SetupAPI(장치 관리자가 숨기는 장치·NoDisplayClass 제외))
  + `src/PcManager.Agent.Linux/SystemMonitor.Linux.cs`(/proc · /sys, lspci 있으면 이름, 없으면 PCI 번호, `who`, 커널 스레드 제외).
  Windows 11인데 ProductName이 "Windows 10"이면 빌드 22000 이상으로 고침. `AgentClientMethods.GetSystemInfo/GetProcesses/GetPerformance/GetDevices`.
- 서버 `Api/PcInfoEndpoints.cs`: `GET /api/agents/{id}/info/system|processes|performance?after=|devices` (시간 제한 10~30초 → 504 "PC가 응답하지 않습니다").
  PIN 잠금 미들웨어가 그대로 막는다(`/api/agents/{agentId}/…`). `ResultSetEndpoints.CallAgent`는 internal로.
- 확인: 로컬 서버+Windows 에이전트+Playwright로 탭 5개·크게 보기·English·접으면 요청 0·높이 조절,
  Linux 에이전트는 Docker `ubuntu:24.04` 컨테이너(`--console --server http://host.docker.internal:5063`)에서 4개 API 확인 (컨테이너라 프로세스 1개·드라이브 /app만).
- 옛 에이전트: 패널에 "에이전트 호출 실패 (에이전트를 업데이트하세요): …".

### 0.8.91: 이미지 찾기 — 긴 영상에서 연결 끊김 수정 · 찾는 중에도 구간 표시
사용자 보고: 20시간 영상에서 찾기가 진행되다 "에이전트 호출 실패 (에이전트를 업데이트하세요): Connection '…' disconnected."
- 원인: 영상 하나를 다 훑으면 프레임별 유사도(1프레임 1바이트, 20시간 60fps = 435만 바이트)를 **한 메시지로** 보냈고,
  base64로 2MB를 넘으면 서버 SignalR `MaximumReceiveMessageSize`(2MB)에 걸려 **서버가 에이전트 연결을 끊음**
  (에이전트 로그 "The server closed the connection … Connection closed with an error", 서버 로그엔 Info로 안 남음).
  재현: 32×18 60fps 7.5시간 영상(162만 프레임)을 ffmpeg lavfi로 24초 만에 만들어 같은 502.
- 수정: 에이전트 `VideoImageSearch.GetChunks(id, video, offset)` (`GetImageSearchChunks`) → `ImageSearchProgress`(조각 목록 + More).
  한 번에 1MB(`ChunkBytes`)까지, 훑는 중인 영상도 **확정된 프레임**(다시 잴 수 있는 마지막 Step개 전)까지 → 웹이 찾는 중에도 구간을 보여 준다.
  서버 GET `…/image-search/{id}?video=&offset=` (없으면 옛 `have` 방식), 옛 에이전트면 `HubException`을 잡아 옛 `GetImageSearch`로 받아 같은 모양으로.
  웹 `imageSearchState.ts`: (영상, 프레임) 커서로 이어 받고 More면 바로 다시, 묻기 실패는 30번(약 30초)까지 다시 물음(404면 바로 그만) +
  "테스트 PC 연결이 잠깐 끊겨 다시 묻는 중…". `request()` 오류에 `status`를 붙임.
- 확인: 7.5시간 영상 162만 프레임을 111번에 나눠 받고 구간 45개 첫 프레임 정확(0·600·1200초…), 화면에서도 찾는 중 구간 4→45개,
  옛 0.8.90 에이전트(임시 git worktree로 빌드) + 새 서버에서도 10분 영상 정상.

### 0.8.91: 이미지 찾기 범위 — 고른 스텝 앞뒤 몇 초만
사용자 요청: 영상 전체가 아니라 특정 스텝을 골라 앞뒤 몇 초만 비교(빠르게). 스텝은 **머리글을 먼저 고르고 그 열의 값에서** 고른다.
- 웹 패널(`ImageSearch.tsx`): [찾을 범위: 영상 전체 | 고른 스텝 앞뒤] → [머리글 ▾] → [값 고르기 ▾](머리글 거르기와 같은 `ColumnFilterMenu`,
  `onSort`가 없으면 '고르기' 모드: 정렬·필터 지우기 없음, 처음엔 아무것도 안 고름) → 앞 N초 · 뒤 M초 (기본 2·5).
  요약 "스텝 n개 → 구간 k개 · 길이 · 영상의 x% · 영상 밖 m개 뺌". 결과 목록에 가장 가까운 스텝 "스텝 #N +1.00초", 시간축에 훑은 구간.
  상태는 `useImageSearch`(scope·stepColumn·stepValues·before·after·searched), 구간 계산 `stepWindows`(겹치면 합침, 영상 길이로 자름).
  스텝 → 영상 위치는 ResultViewer `stepSource.position` (= 표에서 스텝 누를 때와 같은 `videoForRow` + `videoTimeOf`, 보정·배율 반영).
- 에이전트: `ImageSearchRequest.Ranges`(영상 번호·시작·끝 초). `FrameRanges`가 프레임 구간으로 바꾸고 1초 안으로 붙은 것은 합침,
  `ScanRangeAsync`가 구간마다 ffmpeg `-ss`(키프레임부터) `-t` `-frames:v`로 그 부분만 읽음, 훑지 않은 프레임은 0, 구간마다 추적 상태 새로.
  옛 에이전트는 `Ranges`를 몰라 영상 전체를 훑지만, 웹이 구간 안에서 시작한 것만 보여 줘서 결과는 같다 (느릴 뿐).
- 확인: API로 7.5시간 영상의 4구간 1.6초(전체 112초), 600.000·1800.000초 정확. 화면: Reference RFW Result + 스텝 시각에 맞춰 만든 1시간 영상
  (`KW Name` = Here Navi-in-Cluster 7스텝 +1초에 사각형, 1800초에 무관한 사각형) → 스텝 모드 2.6초 7개 모두 "+1.00초", 전체 모드 16.7초 8개.

### 0.8.91: 결과 확인 — 표 위 요약 · 영상 자르기를 스텝으로
사용자 요청: 표 머리글 위에 시작·종료·총 시간·Cycle / 자르기 창의 [지금 위치]를 [스텝 선택]으로, 끝 스텝은 시작보다 앞을 못 고르게, [초기화],
시작·끝이 정해지면 미리보기, 초 대신 실제 타임스탬프, 창을 닫아도 고른 스텝 유지 (껐다 켜며 조절).
- 표 위 `RunSummary`: 시작 = 첫 스텝 시각, 종료 = 스텝 시각 + 걸린 시간의 최댓값(마지막 스텝이 끝난 시각), 둘 다 날짜까지 · 총 시간 h:mm:ss,
  Cycle = 돈 횟수(Cycle 값 종류 수) / 계획(RFW 'Cycle Total' 최댓값 → `ParsedResult.cycleTotal`). 경과 시간 Result는 총 시간·Cycle만.
- `TrimDialog` (웹만, 에이전트 `TrimVideo` 그대로): 고른 스텝은 Viewer 상태 `trimSel`(시작·끝 행 번호 + 시작 앞·끝 뒤 여유 초)이라 창을 닫아도 남는다.
  구간 = 시작 스텝 시각 − 앞 여유 ~ 끝 스텝이 끝난 시각(걸린 시간, 없으면 다음 스텝까지) + 뒤 여유, 영상 위치는 이미지 찾기와 같은 `stepSource.position`.
  `StepList`: 시각순 · 검색 · 보이는 줄만 그림(1만 6천 행), 끝 스텝은 시작 스텝 차례 앞이 disabled, 열면 고른 스텝 근처로.
  시작을 끝보다 뒤로 바꾸면 끝을 비움. 서로 다른 영상·영상 밖이면 안내. 미리보기 `<video>`(재생 준비된 사본 주소)로 구간 시작부터 재생, 끝에서 멈춤.
- 확인: Reference RFW Result(시작 13:07:34 · 종료 16:44:36 · 3:37:02 · Cycle 10/10, CSV 계산과 같음), 스텝 #129~#129 + 뒤 여유 2초를 잘라 5.53초 파일.

### 0.8.91: SignalR 보안 업데이트
NuGet 경고 NU1903 (GHSA-334f-vvp4-7g6p, CVE-2026-70159, SignalR stateful reconnect DoS). 우리는 stateful reconnect를 안 써서 실제 영향 없음,
서버는 self-contained라 CI의 SDK 10.0.402(런타임 10.0.13)로 이미 패치됨. 경고를 없애려고 Microsoft 패키지 10.0.12 → **10.0.13** (에이전트 2개 + 서버).

### 0.8.92: 영상 자르기 모드 — 모달 대신 표에서
사용자 요청: 자르기를 모달이 아니라 오른쪽 결과 표를 그대로 두고 [시작 스텝]·[끝 스텝] 버튼으로 표에서 고른 행을 지정,
정보는 이미지 미리보기 자리, 미리보기는 영상 자리에서 고른 구간만 (4초면 4초짜리 영상처럼), 자르기 종료하면 원상복구.
- 자르기 모드 = `dialog === 'trim'` (Esc로 끝, 영상 단축키는 켬). [✂ 자르기]가 켜고 끈다. 이미지 찾기는 같은 자리를 써서 닫고 막는다.
- 표 위 `rv-trim-bar`: 고른 행(`selected`) → [시작 스텝] · [끝 스텝](시작 스텝 차례보다 앞이면 disabled) · [자르기 종료].
  표 `RowTable`의 `trim` 속성: 시작·끝 행 `trim-start`/`trim-end`(주황 왼쪽 막대), 그 사이 `trim-in`.
- 이미지 자리 `TrimPanel`: 시작·끝 스텝과 실제 시각, 시작 앞·끝 뒤 여유, 초기화, 길이, [자르기](`api.trimVideo`), 저장 결과.
  구간 계산은 `trimRange` (시작 스텝 − 앞 여유 ~ 끝 스텝이 끝난 시각 + 뒤 여유, 영상 위치는 `stepSource.position`).
  고른 스텝은 Viewer 상태 `trimSel`이라 자르기를 끝냈다 다시 켜도 남는다. 구간이 정해지면 그 영상으로 바꾼다(`clipKey`가 바뀔 때만).
- `VideoTransport`의 `clip` 속성: 탐색 막대·시간이 0~구간 길이, 구간 밖으로 가면(표에서 다른 스텝을 눌러 이동 등) 구간 끝으로,
  재생은 화면 갱신마다(requestAnimationFrame) 구간 끝을 보고 멈춤, 끝에서 다시 누르면 처음부터. "✂ 구간" 표시.
- 옛 모달 `TrimDialog`·`StepList`와 그 문구는 지움.
- 확인: 시작 #669 → #129 고르면 [끝 스텝] 막힘, #129~#129 = "0:00.0 / 0:03.5"로 재생해 306.699초(구간 끝)에서 멈춤,
  #129~#669 = 6:57.8, 자르기 종료하면 "/ 1:00:00.0"·이미지 자리 돌아옴, 다시 켜면 그대로, Esc 종료, 잘라 417.8초 파일.

### 0.8.92: 이미지 찾기 결과 목록 — 머리글 있는 표·엑셀 내보내기
사용자 요청: 누른 줄 하이라이트(스크롤하면 어디를 봤는지 모름), 시간 라벨은 연-월-일 시:분:초.밀리초 하나로, 스텝 왼쪽에 몇 번째 Cycle, 열 정렬.
- `ImageSearch.tsx` 목록: 줄 전체를 누르면 `state.picked`(훅, `경로:첫 프레임`, 새로 찾으면 비움) → `li.picked` · 시간축 마크도 `picked`,
  시간축 마크를 누르면 목록이 그 줄로 스크롤(`scrollIntoView nearest`).
- 스텝: 고른 스텝 앞뒤로 찾았으면 가장 가까운 고른 스텝, 영상 전체로 찾았으면 그때 하던 스텝(`rowAtTime`, 테스트가 끝난 뒤면 없음).
- 이어서 요청: 머리글 + 내보내기, 고른 머리글만 표로. 목록이 머리글 있는 표가 됨(`RESULT_COLUMNS`/`COLUMN_SPEC`):
  시각 · Cycle · 스텝 · 스텝 이름 · 스텝부터(초) · 길이(초) · 유사도(%) · 프레임 (· 영상, 영상이 둘 이상일 때).
  머리글마다 체크(`state.exportColumns`, 훅이라 패널을 닫아도 유지) — 뺀 열은 머리글에 줄, 칸은 흐리게. 머리글은 sticky,
  열 폭은 `--search-cols`, 줄마다 같은 `--search-min` 폭(좁으면 가로 스크롤 — 1500px 창에서 프레임 열이 스크롤 밖, 1920px은 다 보임).
- 내보내기(`tableExport.ts`, `ResultViewer`의 `copyTable`도 여기로 옮김): [엑셀로 내보내기] = 라이브러리 없이 만든 .xlsx
  (STORE zip, 시트 하나, 머리글 굵게·틀 고정, 열 폭, 숫자는 숫자 칸 + 소수 자릿수 서식, 나머지는 글자 칸) —
  CSV는 엑셀이 시각을 날짜로 바꿔 초·밀리초를 숨겨서 쓰지 않음. [표 복사] = TSV+HTML(엑셀에 붙이면 칸마다).
  내보내는 머리글은 화면 언어(`tr`). 실제 엑셀(COM)로 열어 시트·서식·값 확인함. 영상 둘 이상(영상 열)은 브라우저로 확인 안 함.

### 0.8.93: 이미지 찾기 크롭 창
사용자 요청: 크롭할 때 지금 프레임을 모달로 띄워, 확대해서 세밀하게 크롭.
- 영상 위 드래그(`CropOverlay`의 그리기)는 없앰 → 오버레이는 크롭·영역 표시만. 상태 `drawing` 대신 `crop: CropTarget | null`
  (`kind` 'template'|'area' + `frame: FrameShot` = `grabFrame`이 영상 원래 크기로 떠 둔 캔버스·경로·초, 영상은 멈춤).
  [🔍 이미지 찾기]는 크롭이 없으면 `start(grabFrame(...))`로 바로 크롭 창, 패널 [크롭]/[다시 크롭]·[영역 지정](직접 지정)은 `grab` 속성으로 연다.
  프레임을 아직 못 읽으면 패널에 안내. 크롭 창이 열린 동안 영상 단축키는 끔(`keysEnabled`에 `!search.crop`).
- `CropDialog`(`<dialog>` showModal, 패널 안에서 렌더 — VideoTransport 밖이라 클릭이 영상 재생으로 안 감):
  보기 칸 캔버스에 보이는 부분만 그림(확대 시 부드럽게 하지 않음, 800%부터 픽셀 경계선), 배율 맞춤(처음)~4000%,
  휠 = 커서 기준 확대(passive 아닌 네이티브 리스너), Space/가운데 버튼 끌기 = 이동, −/+/맞춤/1:1/고른 부분 확대, 커서 픽셀 좌표.
  고르기는 픽셀 단위(누른 픽셀~놓은 픽셀 포함), 안쪽 끌기 = 옮기기, 테두리 띠·모서리 = 크기, 누르기만 하면 전 선택 유지,
  방향키 1픽셀(Shift 10) · Ctrl+방향키 크기 · X/Y/너비/높이 숫자 칸 · 미리 보기 · Enter 확인 · Esc 닫기(패널의 Esc 처리가 먼저 받음).
  다시 열면 전 크롭(같은 크기 영상)·전 영역이 처음 선택. 영역 지정 창은 크롭 위치를 주황 테두리로, 영역은 크롭한 영상 크기 기준으로 저장.
- 확인: 32×18 영상에서 12×10 @ (8,4) 크롭 → 예전과 같은 8구간, 방향키·Shift·Ctrl·테두리·옮기기·누르기만·휠·0·Space 이동,
  영역 22×16 지정, 다시 크롭 시 전 선택, Esc는 창만 닫음. 1080p testsrc2 영상으로 맞춤 56% → 휠 991%·격자·고른 부분 확대 253%.

### 0.8.94: 이미지 찾기 옵션 두 줄 · 슬라이드 쇼
사용자 요청: 옵션을 더 컴팩트하게, 지정한 초마다 찾은 프레임을 자동으로 넘기는 슬라이드 쇼.
- 패널 머리(제목·설명)·왼쪽 크롭 그림 칸(96px)·따로 있던 요약 줄을 없애고 옵션을 두 줄로(`.rv-search-bar`, 좁으면 무리 단위로 줄바꿈):
  ① 이미지 찾기(설명은 툴팁) · 크롭 그림(높이 22px, 크기·영상·시각은 툴팁) [다시 크롭] · 검색 영역 · 유사도(라벨 '유사도 기준'→'유사도') ·
  끊김 무시 · 오른쪽 끝 [찾기][✕]  ② 찾을 범위 (+ 머리글·값·앞뒤 초) · 요약(영상 전체면 '영상 N개 · 길이').
  옵션 높이 약 135px → 50px. 패널 1011px에서 두 줄 그대로, 758px에서는 ②의 요약만 다음 줄, 505px에서는 ①이 두 줄.
- 앞·뒤·슬라이드 초 칸은 `SecondsField`(uncontrolled: 쓰는 동안 쓴 그대로, 숫자면 min~max로 바로 반영, 칸을 떠나면 반영된 값) —
  예전엔 지우면 0이 되어 3을 치면 '03'이 되던 것.
- 슬라이드 쇼(찾은 구간 줄 오른쪽 [▶ 슬라이드 쇼] [2]초 · 3/48): 누른 줄부터(마지막 줄이면 처음부터) 목록 차례로 `pick` →
  `state.picked`가 지금 장(하이라이트·스크롤·시간축 마크), 영상은 멈춘 채. 시간은 그 프레임이 화면에 나온 뒤부터 셈(`nowSeconds`가 목표
  프레임 반 프레임 안 + 같은 영상) — 테스트 PC에서 받는 영상은 이동이 느릴 수 있어서, 10초 지나도 안 나오면 다음 줄. 끝 줄 다음엔 멈춤.
  타이머는 `useEffectEvent`(`nextSlide`)라 찾는 중 목록이 다시 만들어져도 키로 봐서 안 끊김. 줄을 누르면 거기서 이어 감,
  Esc(크롭 창 → 값 고르기 → 슬라이드 쇼 → 패널 순) · 영상 재생(Space/▶, window capture 'play' + `videoRef`) · 크롭 창 열기 · 패널 닫기면 끝.
  한 장 시간은 훅 상태 `slideSeconds`(0.5~60, 패널을 닫아도 유지). `ImageSearchPanel`에 `videoRef` 속성 추가.
- 확인: 32×18 영상 8구간에서 1초 → 3/8부터 약 1.06초마다 다음, 8/8 뒤 멈춤(영상 계속 멈춤), 마지막 줄에서 시작하면 1/8,
  Esc는 슬라이드 쇼만, 도중에 6번째 줄 누르면 6/8→7/8, Space 재생하면 끝. testsrc2 영상 2개에서 영상을 바꿔 가며 넘김 확인.
  English 문구·툴팁 확인. 콘솔 오류 없음.

### 0.8.94: 필터 값 목록 크기
사용자 요청(스크린샷: ATS 'STEP REMARK' 필터 값 목록에 1.5줄만 보이고 가로·세로 스크롤 막대): 목록이 너무 작음.
- 원인: 목록 높이 = 줄 수 × 20 + 8 — 테두리 2px가 빠져 늘 2px 모자라 세로 막대가 생기고, 창 폭(글자 + 64)에는 그 막대 자리가
  없어 가로 막대까지 생겨 줄을 가림. 값이 1~2개면 목록 칸 자체가 48px. (Playwright 기본 브라우저는 `--hide-scrollbars`라
  막대 폭이 0 → 안 보임. 확인은 `browserType().launch({ channel: 'chrome', ignoreDefaultArgs: ['--hide-scrollbars'] })`로, 막대 15px)
- `ColumnFilter.tsx`: 줄 22px·글자 13px, 목록 높이 = 값 수로(검색해도 그대로) 최소 8줄 ~ 최대 440px + 여백·테두리 10px,
  화면보다 긴 값이면 가로 막대 자리 17px 더함. 세로 막대 자리는 CSS `scrollbar-gutter: stable`로 늘 비우고 창 폭에 17px 포함.
  위치는 목록 밖 창 높이 추정(정렬 있음 184 / 값 고르기 100, 실측 178~180 / 96)으로 화면 아래를 넘지 않게, 그래도 낮으면
  `maxHeight` + 목록 `flex: 0 1 auto; min-height: 72px`로 목록만 줄어듦. 결과 표 머리글 필터와 이미지 찾기 값 고르기 창 모두.
- 확인(막대 15px): 값 4개 → 8줄 칸에 다 보임, 26개 → 440px에 19줄 + 세로 막대만, 가로 막대 없음. 900px 창의 긴 값 →
  가로 막대가 있어도 줄이 안 가림. 높이 560 창 → 목록이 줄고 [확인]이 화면 안. 기존 ColumnFilter 경고 4개는 원래 있던 것.

### 0.8.95: 영상 분석 — ReplayKit_FailAnalyzer 이식
사용자 요청: `E:\Project\choisjin\ReplayKit_FailAnalyzer`(rkfa, Python)의 영상 분석 기능을 가져와 지금 불러온 Result·영상으로.
- 결과 확인 영상 도구 모음 [📊 영상 분석] (이미지 찾기·자르기와 같은 자리, 하나만 열림): 이 실행의 영상들을 테스트 PC에서 프레임마다 재서
  검은 화면·깜박임·정지 구간·화면 전환. 그래프 · 탭(개요·종류별 목록) · 그때 스텝 · 영상 위 화면 영역(빨강)·베젤(노랑) · 탐색 막대 종류별 색.
- 측정 = 에이전트 `VideoAnalyzer.cs` (Windows·Linux 공용, rkfa `_stats`·`detect_screen_roi`·`fit_bezel` 이식): ffmpeg 한 번 디코딩으로
  crop→scale=320→signalstats(YAVG·YDIF·UAVG·VAVG를 stdout) → edgedetect→signalstats(YAVG, edge.txt) → scale=8:4 area→signalstats(YMAX, grid.txt)
  (+베젤: split→외곽 crop→scale=160→YAVG(outer.txt), 테두리 띠 = (외곽×외곽 면적 − 화면×화면 면적)/면적 차). 작업 폴더 안 상대 경로(필터의 ':' 회피).
  구간 15·30·60초(10분 뒤 300초), 구간마다 1초 앞에서 시작, ffmpeg 최대 4개(코어 절반)가 앞 구간부터 → 앞에서부터 차례로 붙임.
  화면 영역: 지정 → 없으면 추정 (영상 4개까지 고르게 8장씩 128×72 회색조, 8×6칸 윤곽 변화폭 ≥ max(15, 최대의 30%)인 칸들의 사각형, 4칸 미만·15% 미만이면 전체).
  프레임당 31바이트 (시각 double + 밝기·차이·윤곽·칸 윤곽·베젤 float + RGB) = rkfa 저장 정밀도와 같게 (처음엔 ms·0.01 단위였는데 판정 경계 근처 값이 뒤집혀 바꿈).
  조각 1MB씩 + 측정 구간 경계(Marks), 마지막 구간은 경계와 끝남을 한 잠금에. 끝난 작업은 15분 뒤 버림 · 2분 동안 안 물으면 멈춤.
  서버: POST/GET/DELETE `/api/agents/{id}/video/analysis[/{jobId}]` (옛 에이전트면 409 "에이전트를 업데이트하세요").
- 판정 = 웹 `videoDetect.ts`: rkfa `_Detector`·`blinks`·`blink_text` 그대로 옮김 (새로 들어온 부분만, 기준값 직전 10분 상위 25%, Python round 반올림까지).
  **rkfa처럼 측정 구간이 끝날 때마다 판정** (기준값 창이 판정 시점마다 달라 받는 대로 판정하면 결과가 달라짐 → Marks에서, 마지막은 final 한 번).
  정지 기준(5·10·20·30·60초, 기본 10)을 바꾸면 다시 재지 않고 같은 경계로 처음부터 다시 판정. 상태·받기는 `videoAnalysisState.ts`, 화면은 `VideoAnalysis.tsx`.
- 크롭 창을 `RectPicker.tsx`(RectPickerDialog: 제목·확인 문구·처음 선택·함께 볼 사각형·색 variant·onApply)로 떼어 이미지 찾기(얇은 CropDialog 래퍼)와 같이 씀.
  공용 도구 `frameUtil.ts` (Box 비율 사각형·clamp·scaleRect·rectToBox·boxToRect·formatFrameTime·useVideoView — CropOverlay도 이것으로).
  화면 영역·베젤은 비율 [x0,y0,x1,y1]로 보냄 (크기가 다른 영상도 같은 자리). 베젤은 직접 지정일 때만, 에이전트가 화면을 감싸게 넓히고 띠가 화면의 3% 미만이면 안 씀.
- 그래프: 밝기(파랑)·베젤(회색)·대비 채움·평균 색 띠·검출 음영·전환(보라 눈금)·스텝(초록, 촘촘하면 아래 짧은 눈금만)·실패 스텝(빨강)·안 잰 부분(회색),
  휠 = 커서 기준 확대(최소 0.5초)·Shift+휠/가로 휠·끌기 = 이동·클릭 = 이동(멈춘 채)·더블클릭 = 전체, 프레임이 적으면 선·많으면 픽셀 열마다 최소~최대.
  재생하거나 옮겨 가서 지금 위치가 범위를 벗어날 때만 따라감 (멈춘 채 확대·이동은 그대로 — 처음엔 범위만 바뀌어도 되돌아가던 버그).
- 목록: 길이(전환은 번호)·실제 시각·영상 위치(영상 여럿이면 이름)·그때 스텝(+초)·근거, 500줄씩 더 보기, 누르면 그 순간 1.5초 앞부터 재생
  (`seekTo(path, t, play)` — 다른 영상이면 `pendingPlay`로 불러온 뒤 재생). 전환은 2만 개까지 목록(개수는 전부).
- 확인 (scratchpad `parity/`·`vatest/`·`vacam/`):
  - 합성 프레임 3가지(베젤 유무)를 같은 조각 순서로 넣어 rkfa `_Detector`와 TS 포트 결과 완전히 같음.
  - 합성 영상(2분: 검은 화면 20~23 · 깜박임 30, 35~37 · 정지 40~55 · 전환 55/70/75)을 화면 전체·화면+베젤로 rkfa `analyze_video`와 비교 → 같음,
    1시간 60fps(216,000프레임, 69초)도 정지 9·전환 16 시각·길이까지 같음.
  - 다른 곳 하나 = rkfa 버그: ffmpeg가 지수로 찍은 값(`YDIF=8.68056e-05`)을 정규식 `([0-9.]+)`가 8.68로 읽어 정지 구간이 끊김
    (rkfa `video_analysis._parse_print`, 고치려면 `([0-9.eE+-]+)`). PC Manager는 바르게 읽는다 → 그런 곳은 PC Manager 쪽이 맞음.
  - 웹캠 흉내(격자 배경 속 화면): 자동 추정은 8×6칸이라 배경이 섞여 검은 화면을 못 잡음(rkfa와 같음) → 직접 지정하면 잡힘, 베젤까지 주면 대비로.
  - 영어 문구, 이미지 찾기 크롭 회귀, 콘솔 오류 없음.
- **에이전트 업데이트 필요** (새 에이전트 메서드). 안 옮긴 것: rkfa의 결과 저장(다시 열면 바로)·영상별 영역 기억·기본값 저장, 스텝 탭(오른쪽 표가 있음), 시각 맞추기.

### 0.8.96: ATS 화면 패널 높이 · 영상 분석 ATS 확인
사용자 질문: ATS·RFW 둘 다 영상 분석이 되나.
- ATS 샘플 `Reference/0.0.0meminfo_….csv`(시작 2026-10-06 14:01:33) + 합성 영상을 `2026-10-06 14-01-30.mp4`로 붙여 확인: RFW와 같은 검출
  (검은 화면 1 · 깜박임 2 · 정지 3 · 전환 5), 스텝은 ATS 행(STEP REMARK)으로 붙음 (30초 깜박임 → #1 None +8.36초, 첫 행보다 앞인 검은 화면은 "-").
- ATS 화면은 왼쪽 칸이 `.rv-left.fit`(바깥 스크롤 없음, 영상 최소 160px)이라 창이 아주 낮으면 패널 아래가 잘릴 수 있어
  `.rv-left.fit > .rv-search { flex: 0 1 auto; min-height: 0; overflow: auto; }` (이미지 찾기 패널도 같이). 1920×1000 · 1366×768 · 1366×600에서 목록 끝까지 보임.

### 0.8.97: 영상 분석 화면·베젤을 꼭짓점 넷으로 (비스듬히 찍은 화면)
사용자 요청: 화면·베젤 지정을 직사각형이 아니라 자유형 사각형으로 (사선으로 찍는 경우가 많음).
- 웹 `QuadPicker.tsx`(QuadPickerDialog): 드래그 = 직사각형으로 시작, 꼭짓점(●) 끌기로 사다리꼴에 맞춤, 안쪽 끌기 = 옮기기,
  1~4 또는 꼭짓점 누르기 + 방향키 = 그 꼭짓점 1픽셀(Shift 10), 안 고르면 전체, 꼭짓점 X·Y 숫자 칸, 미리 보기는 반듯하게 편 모습
  (`squareToQuad` 호모그래피로 샘플링 — 에이전트가 펴는 것과 같은 모양). 꼬인(볼록하지 않은) 사각형·8px 미만은 확인 막음,
  베젤은 화면(빨강 점선)을 감싸야 확인됨. 화면을 새로 지정해 베젤이 감싸지 않으면 베젤을 지우고 안내.
- 크롭 창의 보기 칸(크기·확대·이동·그리기·휠·Space·+/−/0)을 `pickerView.ts`(usePickerView)로 떼어 RectPicker·QuadPicker가 같이 씀,
  창 머리·도구 줄은 RectPicker의 PickerHead·PickerTools. 직사각형 창(이미지 찾기)은 그대로 (variant template·area만).
- 상태: 직접 지정한 화면·베젤 = 비율 꼭짓점 넷 `Quad`(값 8개, 왼쪽 위부터 시계 방향), 요청에 그대로. 영상 위 표시는 SVG 다각형,
  개요는 "꼭짓점 x%,y% · …". 꼭짓점 넷을 보냈는데 직사각형(값 4개)이 돌아오면 옛 에이전트 → "에이전트를 업데이트하세요" 경고.
- 에이전트 `VideoAnalyzer.Region`: 값 4개 = 직사각형, 8개 = 꼭짓점 (0~1로, 볼록·1% 이상 아니면 무시 → 추정). 직사각형이면 crop만
  (ReplayKit_FailAnalyzer와 같음), 사다리꼴이면 둘레 crop → (640 폭 넘으면 줄임) → `perspective=…:sense=source`로 펴고
  **가장자리 3% 안쪽만** 잰다 (꼭짓점이 조금만 어긋나도 남는 배경 띠의 경계가 윤곽으로 잡혀 꺼진 화면이 '윤곽 있음'이 되던 것 — 칸 윤곽 8 → 2).
  베젤: 직사각형끼리는 외곽 − 화면 (rkfa와 같게), 꼭짓점이면 변마다 사다리꼴 띠 넷을 각각 펴서(64×16) 재고 넓이(신발끈)로 평균
  (얇은 띠에서 빼기 오차가 커지지 않게). 꼭짓점 베젤이 화면을 감싸지 않으면 안 씀. 꼭짓점으로 받으면 꼭짓점으로 돌려준다.
- 확인 (scratchpad `vaquad/`: 격자 배경 속 화면을 perspective로 비스듬히, 15~18초 검은 화면): 자동 추정(직사각형)은 배경 격자가 섞여 못 잡음 →
  꼭짓점 지정으로 15.0초 3.03초 검은 화면 잡힘(칸 윤곽 2.0), 베젤 꼭짓점까지 주면 "화면−베젤 대비 0 (베젤 밝기 90)"으로.
  꼭짓점 끌기·키보드·꼬임 막기·감싸기 막기·Esc, 영상 위 다각형, 이미지 찾기 크롭(공용 훅) 회귀 확인. **에이전트 업데이트 필요.**

### 0.8.98: 결과 확인 완료 소리 뺌 · 깜박임은 어두워지는 것만
사용자 요청: 결과 확인 화면을 열 때 나는 비프음은 아예 빼기 · 깜박임은 밝아지는 것 말고 밝은 상태에서 어두워지는 것만 잡기.
- 소리: `resultSessions.ts` `announce`(불러오기 완료·실패)의 660Hz 0.2초 소리를 지움. 원래 대시보드 뒤에서 불러오던 때(adecdf4)의 완료 알림인데,
  결과 화면이 새 탭으로 옮긴 뒤(b2b404f) 그 탭은 알림 카드는 숨기고 소리만 남아 열고 불러오기가 끝나는 순간(보통 1~2초 뒤) 울렸다.
  알림 카드(대시보드 탭)·창이 뒤일 때 윈도우 알림(원래 무음)은 그대로, 채팅 알림음(`TransfersPip.tsx`, 880Hz)도 그대로.
- 깜박임 (`videoDetect.ts` `blinks`): 평소 밝기(직전 1초 중앙값)보다 25%(최소 12) 넘게 **어두워졌다가** 0.6초 안에 ±10%로 돌아오는 것만.
  밝게 번쩍였다 돌아오는 것은 깜박임이 아님 → 프레임 차이가 크면 화면 전환으로 셈 (전환에서 빼는 건 깜박임 구간뿐이라).
  근거는 "최대 n% 어두워짐"(가장 어두웠던 프레임), `Blink.kind`·`FlickerInfo.kinds` 없앰. **원본(rkfa)과 다른 점**: 밝게 번쩍임 (깜박임 → 화면 전환).
- 확인: scratchpad `flick/` — rkfa 합성 케이스 3개(어두워짐만)는 그대로 원본과 같음(`compare.ts`), `bright.ts`(번쩍임 섞음)는 옛/새 비교로
  60초·110초 번쩍임(검은 화면 중 81초 포함)이 깜박임에서 빠지고 전환으로, 어두워짐(30초·100~101초)은 그대로.

### 0.8.98: 영상 분석 — 검출 목록을 결과 표 아래로 · 그래프 채움 · 범례 켜고 끄기 · 정지 기준 입력 · 제외 구간 · 베젤 대신 기준 밝기
사용자 요청: 정지 기준 직접 입력 · 자르기처럼 스텝으로 실제 종료 명령이 실행된 구간을 정해 그 구간은 제외 · 분석 결과를 오른쪽 결과 표를 나눠
아래에(위 표), 탭 줄을 영상 조작 줄과 같은 줄에 · 그래프를 아래까지 채우고 영상 정보는 아래 한 줄 · 범례로 원하는 것만 켜기 ·
베젤 고르기를 없애고 영상의 가장 낮은 밝기를 기준 밝기로 (분석 중 갱신).
- 배치: 영상 분석을 열면(`vaOpen`) 오른쪽 `.rv-right.va` = 위 `.rv-right-top`(필터·요약·결과 표, 높이 `--va-top`) + 아래
  `VideoAnalysisResults`(탭 줄 높이 `--va-bar` + 목록). `--va-top`·`--va-bar`는 Viewer가 왼쪽 `.rv-transport`의 위치·높이를 재서
  (ResizeObserver: rv-main·transport·rv-video) `.rv-main`에 넣는다 → 탭 줄 = 영상 조작 줄 (좁아서 두 줄로 접혀도 같은 높이).
  영상 분석 중에는 왼쪽을 늘 fit(바깥 스크롤 없음).
- 왼쪽 패널 `.rv-left.fit > .rv-va` 높이 clamp(240px, 34vh, 520px): 머리 줄 · (진행·오류) · 범례 · 그래프(남는 높이를 채움, 캔버스 크기는
  ResizeObserver) · 영상 정보 한 줄 `.rv-va-info`(영상 N장·fps·길이 · 화면 영역 · 기준 밝기 · 켜진 평소 차이·칸 윤곽·평소 변화 · 분석 완료(걸린 시간)).
  개요 탭은 없앰, 판정 기준은 탭 툴팁.
- 범례 = 버튼(`.rv-va-key`): 누르면 그래프에서 감춤(줄 그음), 끈 것은 localStorage `results.va.hidden`. 제외 구간(빗금)·스텝·실패 스텝은 있을 때만.
- 정지 기준: 숫자 칸 (1~86400초, 0.1초 단위), Enter·칸을 벗어나면 적용 (치는 중에는 다시 판정하지 않음).
- 제외 구간 (`videoExclude.ts`): [⛔ 제외 구간] → 결과 표 위 고르는 줄(`ExcludeBar`): 표에서 고른 행을 [시작 스텝]·[끝 스텝] (자르기와 같은 규칙) ·
  [모든 Cycle] (Cycle이 여럿이면, 기본 켬: 같은 스텝 이름 + 그 Cycle 안에서 몇 번째) · [추가], 추가한 구간 목록(✕로 지움). 구간 = 시작 스텝 시각 ~
  끝 스텝이 끝난 시각(걸린 시간, 없으면 다음 스텝 시작). Viewer가 영상마다 영상 안 초로 바꿔(`baseSeconds`·`toVideoTime`) `applyExclusions`:
  검은 화면·정지 구간은 구간 밖으로 남는 부분만 (검은 화면 0.3초·정지 기준보다 짧으면 버림), 깜박임·전환은 걸치면 버림. 목록·탭 개수·그래프(빗금)·
  탐색 막대 모두 뺀 결과, 탭 줄 오른쪽 "제외 구간으로 뺀 검출 N개", 표의 제외 구간 행은 빗금(`.rv-row.excluded`). Esc: 고르는 줄 → 패널 순.
  세션 상태라 F5·다른 결과로 가면 없어진다 (저장 셋에도 안 들어감).
- 베젤 없앰 → 기준 밝기: 영상마다 0.3초 넘게 이어진 가장 낮은 밝기 (0.3초 창 최댓값들의 최솟값, 받는 대로 이어서 — `scanFloor`).
  꺼진 화면 = 밝기 − 기준 밝기 ≤ max(5, 기준 밝기 15%, 켜진 평소 차이 20%) + 칸 윤곽 없음 + 색 없음 (rkfa 베젤 판정에서 베젤 밝기 자리에 기준 밝기).
  받는 중에 0.5 넘게 낮아지면 그 영상을 처음부터 다시 판정 (분석 중 갱신). 깜박임은 늘 화면 밝기로 (꺼진 화면이 없는 영상은 기준 밝기 ≈ 평소 밝기라
  차이로는 어두워짐이 안 보인다 — 처음에 차이로 했다가 RFW 시험 영상의 깜박임을 놓쳐 고침). 그래프: 회색 가로선 + 그 위 옅은 파랑.
  웹이 베젤을 보내지 않음 (에이전트의 베젤 측정은 그대로 남아 있고 안 쓰임) → **에이전트는 바뀌지 않음 (서버만 업데이트)**.
  - 알아 둘 것: 꺼진 화면이 한 번도 없는 영상은 기준 밝기가 그 영상에서 가장 어두운 화면이라, 그게 윤곽·색이 없는 빈 화면(평평한 회색 등)이면
    검은 화면으로 잡힌다 (원래 판정은 평소 밝기의 절반 아래만). 분석 중에는 더 어두운 곳이 나오기 전까지 잠깐 그렇게 보였다가 다시 판정으로 빠진다.
- 묻기 실패를 견디는 시간 30회(약 30초) → 110초 (스크린샷의 'Failed to fetch' = 서버가 다시 시작·업데이트하는 동안 끊겨 분석이 멈춘 것으로 봄.
  에이전트는 2분 동안 아무도 안 물으면 작업을 버린다).
- 확인 (scratchpad `floor/`·`vasleep/`·`vaupd/`·`vaflash/`): rkfa 합성 케이스(베젤 없음)는 기준 밝기 없이도·있어도 원본과 같음, 반사광으로 평소의
  절반보다 밝은 꺼진 화면(20/35)은 새 판정만 잡음. ATS 샘플(6 Cycle, Sleeping~WakeUp마다 꺼짐)에 맞춘 55분 합성 영상: 검은 화면 4(잠 3 + 고장 1) →
  #20 Sleeping ~ #34 PowertrainRunning 모든 Cycle(구간 6개) 제외 → 검은 화면 1(14:12:00 고장)·전환 8 → 2·뺀 검출 9, 표·그래프 빗금, 정지 구간은
  제외 구간 끝에서 잘려 남음, Esc 순서, ✕로 되돌림. 늦게 나오는 진짜 검은 화면(50분): 기준 밝기 123.7 → 102 (10분 회색 화면이 잠깐 검은 화면) →
  16 (다시 판정, 회색 빠짐). 정지 기준 200 → 정지 3, 0 → 1. 줄 맞춤: 1920×1000(599~637 같음) · 1366×768(조작 줄이 두 줄이어도 415~484 같음) ·
  1366×600 · RFW(wide). 영어 화면 한글 없음, 직접 지정 창(베젤 없이) 정상, 콘솔 오류 없음.

### 0.8.99: 제외 구간 — 첫 Cycle만 보기 · 고치기 · 깜박임은 기준 밝기 가까이까지
사용자 요청: 제외 구간을 고를 때 첫 Cycle만 보이게 · 제외 구간 수정 · 깜박임은 기준 밝기까지 5% 미만.
- 첫 Cycle만: 고르는 줄이 열려 있고 [모든 Cycle]이 켜져 있고 Cycle이 여럿이면 표(`baseRows`)는 첫 회차(`cycles[0]`)만. 회차 드롭다운은 그동안
  첫 회차로 고정·비활성, 고르는 줄에 "표는 첫 Cycle만". [모든 Cycle]을 끄면 전체 회차 (특정 Cycle만 빼려면 다른 Cycle 행도 골라야 해서).
- 고치기: 목록의 ✎ → `ExclusionDraft.editing`(id)에 그 구간의 시작·끝·모든 Cycle을 불러옴, [추가]가 [바꾸기](같은 id로 덮어씀) + [취소].
  ✎ 다시 누르기 = 그만두기, 고치던 구간을 ✕로 지우면 같이 그만둠.
- 깜박임 (`blinks`에 기준 밝기): 기존 조건(25%·최소 12 어두워짐, 0.6초 안에 복귀)에 더해 가장 어두운 프레임이
  기준 밝기 + (평소 밝기 − 기준 밝기)의 5% 미만 (`BLINK_FLOOR`) — 잠깐 꺼짐만. 기준 밝기가 아직 없으면 옛 조건만.
- 확인: `tsc --noEmit`만 (실제 영상으로는 아직 안 봄).
- 첫 태그 빌드가 en.ts 중복 키(TS1117)로 실패 → 고친 커밋(5aa9413)으로 v0.8.99 태그를 옮겨 다시 릴리스. 웹 검사는 CI와 같은 `npx tsc -b`로
  (`tsc --noEmit -p .`은 루트 tsconfig가 하위 프로젝트만 참조해서 src 오류를 못 잡음).

### 0.8.100: ATS 시각은 스텝 시작 · ATS 표 열 · 영상 분석은 테스트 시작부터
사용자 요청: 스텝을 고르면 영상이 한 스텝쯤 앞서 감 · 시각 칸도 시작 시각으로 · ITERATION → CYCLE, 글자 1px 작게, DEVICE·Control 열, 열 폭·여백
최대한 타이트하게 · 테스트 시작 전 영상은 분석하지 않음.
- ATS `Time Stamp`는 스텝이 **끝난** 시각: `Reference/` 샘플 1123행에서 앞 행과의 간격 − 이 행 DURATION(R열, ms) 오차 중앙값 0.01초
  (앞 행 DURATION과는 0.55초). `parseAts`: 행 시각 = Time Stamp − DURATION, `durationMs` = DURATION, 시각 칸(cells[0])도 시작 시각
  (거르기·정렬·엑셀 내보내기 모두). DURATION이 없거나 0이면 그대로. RFW `Start Time`은 시작이 맞음(오차 0.013초 vs 끝으로 보면 0.116) → 그대로.
  → 스텝 이동·따라가기·이미지 찾기 범위·자르기·제외 구간·테스트 시작이 모두 실제 시작 시각. 원본 Video_editor.py도 Time Stamp로 바로 이동했었음.
- ATS 표 열: A·B·N(DEVICE)·O(Control)·P·U·V·X·Y (ACTION CHECK 5, STEP RESULT 7). `TableSpec.columns`의 `fit` = RowTable이 머리글·행 내용 중
  가장 넓은 것에 맞춰 잼(canvas measureText, 표와 같은 글꼴, 260px까지, 거르기로 행이 줄어도 좁아지지 않음 — spec이 바뀌면 다시).
  시각·CYCLE·DEVICE·Control·ACTION CHECK·STEP RESULT가 fit, STATUS·STEP REMARK·DETAIL이 남는 폭을 나눔. `compact`(ATS만): 본문 11px·머리글 10px,
  칸 여백 3px(머리글 1px), # 열 34px. RFW 표는 그대로.
- 테스트 시작 전: Viewer가 영상마다 첫 스텝의 영상 안 초(`testStarts`, 영상 시작을 모르면 0)를 `analysis.startsRef`로 넘김 →
  `VideoAnalysisRequest.Starts` → 에이전트가 그 초부터 구간을 나눠 잼(`Chunks(total, from)`), 테스트 전에 끝난 영상은 빈 결과,
  진행률은 잰 길이로, 화면 영역 추정 표본도 시작 뒤에서. 웹은 [0, 시작]을 제외 구간처럼 검출에서 빼고 그래프에 빗금
  (옛 에이전트는 전체를 재므로 — 첫 프레임이 시작보다 1.5초 넘게 앞이면 "에이전트를 업데이트하세요" 경고). **에이전트·서버 업데이트 필요.**
- 확인: `tsc -b` · dotnet build(Agent·Agent.Linux·Server) · ATS 샘플 파싱(시작 = 앞 행 끝, 오차 중앙값 10ms). 화면·실제 영상은 아직 안 봄.

### 0.8.101: ATS 표 — 겹쳐 보이던 열 · # 열 없앰 · Control 두 줄 · 왼쪽 영상 칸
사용자 요청(스크린샷): 표가 병합돼 보이고 하이라이트가 이상함 · 인덱스 열 삭제 · 머리글 글자 1 더 작게 · Control 값만 글자를 줄여 폭 반, 내용이
흐르게 해서 다 보이게 · 왼쪽 영상 칸 폭 조금 줄이기.
- 원인: 열 폭 합(fit + minmax 최소)이 표보다 넓으면 grid가 행(absolute, left/right 0) 밖으로 넘쳐 행 배경·선택·머리글이 표 폭에서 끊김.
  → RowTable이 열 폭 합을 `minWidth`로 행·머리글·본문에 걸어 가로 스크롤 (넓힌 RFW와 같은 방식). 600px에서 머리글·칸 위치가 같음 확인.
- fit 폭: 행마다 폭의 99% 지점(드문 긴 값은 …, title로 전체) · 최대 `FIT_MAX` 200px. **`getComputedStyle().font`가 Chrome에서 빈 글** →
  대체 글꼴(11px sans-serif)로 재서 시각이 잘렸음 → fontStyle·fontWeight·fontSize·fontFamily로 만들어 잼, `document.fonts.ready` 뒤 다시 잼.
  RFW [전체 보기] 폭 계산도 같은 버그라 같이 고침.
- `TableSpec.noIndex`(ATS): # 열 없음, 기준점 📍은 시각 칸 앞. `wrapCells`(ATS Control): `.rv-wrap` 9px·줄 높이 11px·break-all로 행 높이(26) 안에서
  두 줄, fit 폭은 한 줄 폭의 반 + 4. 머리글(`compact`) 10 → 9px.
- 왼쪽 영상 칸: `.rv-main` minmax(420px, 1.1fr) → minmax(400px, 0.9fr) (ATS·일반 Result, RFW `wide`는 그대로).
- 확인: 임시 하네스(RowTable + `Reference/` ATS 샘플, vite)로 브라우저에서 — 시각 열 안 잘림, Control 두 줄, 가로 스크롤 정렬·하이라이트 끝까지.
  `tsc -b`. 실제 앱 화면(테마 색)은 사용자 확인.

### 0.8.102: ATS 표 DEVICE·시각 · 영상 아래 버튼 두 줄
사용자 요청: DEVICE 값 글자 줄이기 · Time Stamp에서 연도 빼기 · 영상 아래 이미지 찾기·분석·자르기는 아랫줄, 전체 화면·단축키는 윗줄.
- `TableSpec.smallCells`(ATS DEVICE): `.rv-small` 9px 한 줄, fit 폭도 그 글꼴로. `noYear`(ATS): 표 시각 칸만 `MM-DD HH:MM:SS.mmm` (`timeText`) —
  Ctrl+C 복사·거르기·엑셀 내보내기는 연도까지.
- VideoTransport: 윗줄 재생 조작 … ⛶ · ⌨ 단축키, `.rv-break`(flex-basis 100%) 뒤 아랫줄에 `extra`(영상 고르기·이미지 찾기·영상 분석·자르기).
  한 `.rv-transport` 안이라 영상 분석 탭 줄 높이 맞춤(`--va-bar`)은 두 줄 전체.
- 확인: 임시 하네스(VideoTransport + RowTable, ATS 샘플)로 브라우저에서. `tsc -b`.

### 0.8.103: 영상 분석 Cycle 비교 · ATS 표 머리글 가운데·9px
사용자 요청: 첫 번째 사이클을 기준으로 이후 사이클 영상 그래프를 비교해 특이점 찾기 · 머리글 가운데 정렬, 표 글자를 작은 것(9px)에 맞춰 통일.
- `videoCycle.ts` `compareCycles`: 첫 Cycle(시각순 첫 cycle 값)과 같은 스텝(`stepKeys` — 이름 + 그 Cycle 안 몇 번째, videoExclude에서 export)끼리 짝.
  스텝 구간 = 영상 위치(StepSource.position) ~ 걸린 시간(없으면 다음 스텝), 600초까지, 짧은 것(1.4초 이하) 뺌. 짝마다 짧은 쪽 길이로 0.2초 칸 평균
  밝기·RGB → 칸마다 기준의 ±3칸(±0.6초) 중 가장 비슷한 칸과 max(밝기 차/기준, 색 차(채널 최대)/(기준×1.5)), 1 이상이 3칸(0.6초) 넘게 이어지면
  특이점 하나 (가장 다른 칸 값으로), 스텝 시작·끝 0.4초는 안 봄, 제외 구간 안이면 뺌. 기준 기본 25 (`analysis.cycleDiff`, 탭 줄 숫자 칸 5~200).
  Viewer가 vaOpen이고 프레임이 있으면 useMemo로 계산 (받는 중에도 다시).
- 화면: 결과 표 아래 탭 "Cycle 비교"(Cycle이 둘 이상일 때만, 청록 #0f9aa8) — 길이·시각·영상 위치·스텝(+초)·"Cycle n 밝기 a → b (±) · 색 차이 c"
  + [첫 Cycle 보기](기준 Cycle 같은 자리). 그래프: 범례 "첫 Cycle 밝기"(주황, `CycleMap`으로 같은 스텝 자리에 옮겨 칸 평균, 짝마다 이어 그림 —
  처음에 빈 칸마다 선을 끊어 확대하면 안 보였음) · "Cycle 차이"(청록 음영). 탐색 막대에도 청록.
- ATS 표(`compact`): 본문도 9px(머리글·Control과 같게, DEVICE 전용 작은 글자 설정 없앰), 머리글 모두 가운데 (▾는 글자 옆).
- 확인: scratchpad `cycle/run.ts` — ATS 샘플(6 Cycle) 스텝마다 이름별 밝기 모양 + Cycle마다 ±0.3초 어긋남·잡음, 3번째 Cycle 2초 꺼짐 → 특이점 1건
  (#417 +1.8초, 133 → 8), 4번째 Cycle 0.3초 튐은 안 잡힘, 579스텝 비교. 임시 하네스(VideoAnalysisPanel·Results)로 탭·목록·겹침선·음영 확인. `tsc -b`.

### 0.8.104: 별칭 지워짐 버그 · PC 정보 패널 확대 · 영상 분석 화면 영역 직접 지정 · 정지 기준 최소값
사용자 보고: Renault 서버에 등록한 PC 별칭이 가끔 초기화됨. 요청: PC 정보 패널을 Result·원격 창 모드·전체 모드에도 / 화면 영역 자동 추정 삭제(버튼 하나) /
정지 기준 최소값 = 제외 구간을 뺀 최소 duration.
- 별칭 버그 원인: `pcGroups.ts` `deleteFolder`가 `{ folders, assignments }`만 돌려줘 aliases가 빠짐 → PUT `/api/pc-groups`(문서 통째 저장)에서
  서버 `Normalize`가 `Aliases ?? 빈 사전` → 폴더를 지울 때마다 그 서버의 별칭 전부 삭제. 고침: `...groups` 유지 + 서버 `PcGroupStore.Save`는
  Aliases가 null이면 저장된 별칭 유지(옛 탭 방어). 지워진 별칭은 복구 불가. 남은 위험: 통째 저장(last-write-wins)이라 연결 끊겼던 오래된 탭이
  그사이 바뀐 것을 덮어쓸 수 있음 — 사용자에게 알림, 차이만 보내는 PATCH는 하지 않음.
- PC 정보 패널(`PcInfoPanel`)을 Result PC 목록(`ResultsPage` aside 아래, 고른 PC) · 원격조작 PC 목록(`RemoteModal`, 창 모드 aside와 전체 화면 overlay,
  지금 PC) 아래에도. `RemoteContextValue.agents` 추가(FileExplorer·RemoteTabHost가 넣음). `.remote-pclist`는 flex 세로 + 목록만 스크롤,
  overlay 안 패널은 불투명 배경. 높이 조절 최대는 패널을 담은 목록 높이(`parentElement.parentElement`). 접힘·탭·높이 localStorage는 네 곳 공유.
- 영상 분석 화면 영역: `RoiMode`(자동 추정·화면 전체·직접 지정) 없앰 → [화면 영역] 버튼(지정 전엔 primary) 하나, 지정 전엔 [분석] 비활성.
  에이전트 `DetectScreenAsync`·`SampleAsync`·`CellEdges`와 표본 상수 삭제, Roi가 null이면 화면 전체.
- 정지 기준: 최소값 = 제외 구간 밖(`rowsInExclude`) 스텝 중 가장 짧은 DURATION(0.1초 올림, `STATIC_MIN` 1초 미만이면 1, DURATION 없으면 1).
  지금 값이 최소보다 작으면 Viewer effect가 `changeStatic(최소)`로 올림 (최소가 다시 내려가도 값은 그대로).
- 확인: `tsc -b`, 서버·에이전트(Windows·Linux) 빌드. 화면 확인은 하지 않음.

### 0.8.105: 결과 확인 작업 유지(PiP·완료 알림) · 예약 분석 · PC 목록 폭 통일
사용자 요청: 영상 분석·이미지 찾기는 멈추지 않는 한 계속, 진행을 PiP(결과 확인 탭에도 대시보드와 같은 PiP)에, 완료 알림, 탭을 닫거나 새로 고쳐도
유지(15분 보관 아님), 완료되면 PC 목록에 '분석 완료' / Result 예약 분석(첫 Cycle 뒤 영역·제외 구간을 정하고 날짜·시각 → 그때 에이전트에서 시작,
영상은 사이클별 파일·통 파일 모두, Result와 싱크) / 원격 PC 목록 폭 = PC Manager 트리와 같게 (모든 곳).
- 에이전트 `VideoAnalyzer`·`VideoImageSearch`: 묻는 웹이 없으면 2분 뒤 멈추던 것(Abandoned·Polled)과 끝난 뒤 15분 삭제(Keep) 없앰 →
  끝난 작업은 최근 4개(분석)·8개(찾기), 7일까지 (`Prune`, 메모리 — 에이전트 다시 시작하면 사라짐).
- 서버 `ResultJobStore`(result-jobs.json, 웹 설정 Params는 목록과 따로) · `ResultJobPoller`(2초마다 running 작업을 에이전트에 물음:
  분석 GetVideoAnalysisChunks(id, int.MaxValue, 0), 찾기 GetImageSearch(id, int.MaxValue) — 옛 에이전트도 이 묻기로 안 멈춤, 없어지면 lost)
  · Hub `ResultJobsChanged` · API `/api/result-jobs` (GET · POST 등록 · /{id}/params GET·PUT · /{id}/seen · DELETE=돌면 멈추고 뺌).
- 웹 `resultJobs.ts`: 목록 스토어(useResultJobs, 받기 전 null → 처음 받은 건 알리지 않음) · `sourceKeyOf` = agentId|resultPath (영상은 예약이
  더 모아 달라질 수 있어 뺌) · `openJob`(이 탭에 그 결과가 있으면 그 화면+패널, 없으면 새 결과 확인 탭 `ResultTabRequest.panel`).
  `useVideoAnalysis`·`useImageSearch(ctx: JobContext, videos)`: 시작하면 등록(설정 params 포함), 화면을 닫으면 받기만 그만(취소 안 함),
  열면 영상 목록이 정해진 뒤 한 번 findJob → params 되살리고 `follow(id)`로 처음부터 다시 받음. 받은 영상은 **경로로** 화면 영상에 맞춤
  (readPath·path, 없으면 건너뛰고 경고). 설정 바꾸면 1초 뒤 params PUT. 패널에서 끝난 결과를 보면 seen.
  PiP(`TransfersPip`, 결과 확인 탭에도 렌더, `body.rv-open .pip` 숨김 규칙 삭제): '영상 분석 · 이미지 찾기' 항목(내 것만, 열기·멈춤·✕),
  running→끝남이면 펼치고 윈도우 알림(tag pcm-job-id)+알림음. ResultsPage PC 목록: '분석 n%' · '분석 완료'(안 본 것, 누르면 openJob).
- 예약: 서버 `ResultScheduleStore`(result-schedules.json) · `ResultScheduler`(10초마다, 시각 지난 pending + PC 온라인이면 시작) · Hub
  `ResultSchedulesChanged` · API `/api/result-schedules`(GET·POST·DELETE). 시작: 고른 영상 폴더들을 ListDirectory → 고른 영상 중 가장 이른
  수정 시각 이후 영상 + 고른 영상, 수정 시각순 → StartVideoAnalysis(Paths, Starts: 고른 영상은 예약 때 testStarts, 새 영상 0) ·
  StartImageSearch(Paths, Ranges=null 영상 전체) → ResultJobStore 등록 (Open = {source: 모은 videoPaths}, 분석 params.starts 바꿈).
  웹 `ScheduleDialog`(결과 확인 상단 [⏰ 예약 분석]): 시각(datetime-local, 기본 지금+첫 Cycle 길이), 영상 분석(화면 영역 있어야)·이미지
  찾기(크롭 있어야) 체크, 첫 Cycle 안내, 이 결과의 예약 목록·취소. `schedulePayload()`가 요청·params(paths 비움). PiP '예약 분석'·PC 목록 '⏰ 시각'.
- PC 목록 폭: `--pc-list-w: 260px` (PC Manager 트리 · Result PC 목록(300→260) · 원격조작 창 모드(170)·전체 화면(190)).
- 확인: `tsc -b`, oxlint(새 경고 없음), 서버·에이전트(Windows·Linux) 빌드, 임시 서버로 result-jobs·result-schedules API(등록·params·seen·삭제·
  검증 400·재시작 후 다시 읽기). 에이전트와 실제 영상으로 끝까지는 확인 못 함 (예약 시작·이어 받기·알림 — 첫 사용 때 확인 필요).

### 0.8.106: GPU 디코딩·인코딩 · 분석 경과·걸린 시간
사용자 요청: GPU를 쓸 수 있는 곳 중 1) 영상 분석·이미지 찾기 디코딩 2) 재생용 사본 변환 인코딩 / 분석 경과 시간·완료 시 걸린 시간 표시.
- 에이전트 `FfmpegGpu.cs`(Linux에도 링크): 디코딩 `-hwaccel auto`(필터는 CPU라 자동으로 메모리로 내려옴) · 인코더는 시험 인코딩(testsrc2 10프레임)으로
  nvenc → qsv → amf 중 되는 것 (없으면 libx264). `VideoAnalyzer.MeasureAsync`: GPU로 실패하면 CPU로 다시, CPU로는 되면 `DecodeFailed`(이후 CPU만).
  `VideoImageSearch.ScanAsync`: 구간에서 한 프레임도 못 읽으면 CPU로 다시. `VideoTrimmer.RunGpuAsync`(사본 변환 transcode·자르기):
  GPU 디코딩+하드웨어 인코더 → 실패하면 CPU 디코딩+인코더(되면 `_transcodeDecodeOff` — 다시 인코딩할 때만, 예: AMF가 DXVA2 장치와 같이 안 됨,
  개발 PC에서 재현) → CPU 디코딩+libx264(되면 `EncodeFailed`). 시간 초과(-1)는 다시 하지 않음.
- 실측(개발 PC 24스레드 + NVIDIA, 1080p 120초): CPU 시간 분석 26.8→15.2초, 찾기 18.3→3.8초, 변환 81.2→11.2초 / 걸린 시간은 이 PC에선
  조금 늘어남(3.9→4.6, 1.3→3.0, 5.8→6.8초 — CPU가 강하면 GPU 왕복이 더 듦). 코어가 적은 테스트 PC는 빨라지고 테스트 중 CPU 부담이 준다.
- 경과·걸린 시간: `useNow(active)`(resultJobs, 1초마다) · 분석 패널 "분석 중 n% · 경과 …"·"멈춤 — …(걸린 시간)" · 이미지 찾기 "찾는 중 n% · 경과 …"·
  "찾은 구간 n개 · 걸린 시간 …"(`startedAt`·`elapsed` 상태, 다시 열면 서버 작업의 started·finished로) · PiP 작업 "경과 …"/"걸린 시간 …".
- 확인: 에이전트(Windows·Linux)·`tsc -b`·oxlint, ffmpeg로 인코더 감지(이 PC nvenc·amf 됨, qsv 안 됨)·위 측정. 실제 에이전트로 끝까지는 못 봄.

### 0.8.107: 원격조작 하드웨어 H.264 인코더
사용자 요청: GPU 사용 3번 — 원격조작 화면 인코딩.
- `Remote/H264Encoder.cs`: MFTEnumEx(HARDWARE|SORTANDFILTER)로 하드웨어 MFT 먼저 (비동기: Attributes TransformAsync 확인 → TransformAsyncUnlock=1,
  IMFMediaEventGenerator 이벤트를 전용 스레드 `PumpEvents`가 GetEvent(0)로 받아 BlockingCollection에). `EncodeAsync`: NeedInput 자리를 기다려
  (최대 2초, 넘으면 고장) ProcessInput → HaveOutput을 100ms까지 기다려 ProcessOutput, 와 있는 이벤트 마저 처리 — 동기 MFT와 같은 Encode 모양.
  설정 실패면 다음 후보 → 소프트웨어(SYNCMFT). 인코딩 중 예외·시간 초과면 `_hardwareBroken`(이후 소프트웨어만) + 그 자리에서 소프트웨어로 바꿔
  키 프레임부터. 닫을 때 비동기면 MFShutdownObject로 GetEvent를 풀고 스레드 Join. FriendlyName이 빈 문자열로 와서 기본 이름. `Hardware` 속성.
- BGRA→NV12 변환은 그대로 CPU (`Nv12Converter`). D3D11 텍스처를 바로 넘기려면 DXGI 관리자·D3D 인식 MFT가 필요 — 하지 않음. Linux 그대로.
- 확인: 임시 콘솔(리플렉션)로 1080p 300장 — GPU(NVIDIA) 출력 300·키 2(요청한 대로)·CPU 0.8초 vs 소프트웨어 4~5초, 평균 1.7ms vs 2.2ms,
  ffmpeg로 GPU 출력 300장 디코딩(Constrained Baseline). 실제 원격조작 화면으로는 못 봄.

### 0.8.108: 원격조작 변환 SIMD · GPU 사용 표시
사용자 질문·요청: BGRA→NV12 변환이 무엇·효과 → 측정(4코어 제한, 1080p 같은 크기 프레임당 CPU 5~11ms로 인코딩(GPU 2.8ms)보다 큼) →
SIMD 최적화 + 테스트 PC에서 GPU를 실제로 쓰는지 화면에 표시. (낮은 GPU도 효과: 영상 전용 회로라 등급 영향 적음 — 답변만)
- `Remote/Nv12Converter.cs`: 같은 크기는 Vector128로 8픽셀씩(BGRA를 Shuffle로 R·G·B 16비트 평면, Y는 ushort 산술, UV는 2×2 합을 32비트로),
  축소는 원본 줄을 열마다 SIMD로 세로 합(`SumRows`) → 가로 구간 합(구간 폭 표) → 나눗셈 대신 역수 곱(ceil(2^32/n), 정확) → 평면 R·G·B로
  `WriteRows`(SIMD). `[SkipLocalsInit]`. 예전 코드와 바이트 단위로 같음(11가지 크기, 8의 배수 아닌 폭 포함). 4코어 CPU/프레임:
  1080p 같은 크기 5.3→1.9ms, 4K 같은 크기 21.7→7.5ms, 1080p→720p 9.4→5.6ms, 1440p→1080p 20→11.4ms, 4K→1080p 23→15.6ms(메모리 대역폭).
- 표시: `PcSystemInfo.VideoAcceleration`(선택 인자 — 서버도 업데이트해야 전달) · Windows `SystemMonitor.VideoAcceleration()`:
  `H264Encoder.HardwareEncoders`(하드웨어 MFT 제조사 VEN_10DE/8086/1002, 처음 한 번 Lazy) · `HardwareBroken` · `FfmpegGpu.Status()`(디코딩
  GPU/CPU, 사본 인코더 확인 전/GPU(이름)/CPU). Linux는 원격 CPU(libx264) + ffmpeg 상태. 웹 PC 정보 시스템 탭 '영상 가속' 줄들.
  원격조작: format에 `hardware`, 도중에 소프트웨어로 바뀌면 `{type:'encoder'}` → 상태 줄 끝 'GPU 인코딩'/'CPU 인코딩'(마우스: 인코더 이름).
- 확인: 에이전트(Windows·Linux)·서버 빌드, `tsc -b`·oxlint, 임시 콘솔로 정확성·속도·HardwareEncoders(이 PC: AMD·NVIDIA)·Status.

### 0.9.0: GPU 고르기(가상 디스플레이 제외, 외장 → 내장) · GPU 디코딩 실패는 그 영상만 CPU로
사용자 보고: i7-10700K + GTX 1660 SUPER + StarDesk 가상 디스플레이 PC에서 분석 중 CPU 100%·GPU 2%, PC 정보 '영상 분석·이미지 찾기 디코딩:
CPU (GPU 디코딩이 실패해 바꿈)'. 요청: 가상 디스플레이는 자동 제외하고 외장 → 내장 순으로 자동 사용 / 실패 처리 개선 / (분석 ffmpeg 우선순위
낮추기는 하지 않음). 버전은 이번부터 0.9.x (사용자 요청).
- 원인 추정: `-hwaccel auto`가 기본(첫) 장치를 골라 가상 디스플레이에서 실패 → 0.8.106 코드는 한 번 실패로 에이전트가 끝날 때까지 GPU 디코딩 끔.
  (CPU 100%는 필터·ffmpeg 4개 동시라 GPU 디코딩이어도 상당 부분 남음, 작업 관리자 GPU %는 3D — 디코딩은 'Video Decode' 그래프라고 답함)
- `GpuAdapters.cs`(Windows만, `[ModuleInitializer]`로 `FfmpegGpu.FindAdapters`에 넣음 — 서비스·원격 세션 어느 프로세스든): DXGI EnumAdapters1에서
  Software 플래그·NVIDIA/AMD/Intel(10DE·1002·1022·8086) 아닌 것 빼고, (제조사·장치 id·이름)이 같은 것은 첫 번째만(개발 PC에서 같은 NVIDIA가
  LUID 다르게 3번 나옴 — 가상 디스플레이), 전용 메모리 큰 순(외장 → 내장). DedicatedVideoMemory는 `(ulong)(nuint)`로 (PointerUSize→uint
  암시 변환이 16GB에서 OverflowException — 시험 중 발견).
- `FfmpegGpu`: `DecodeOptions(path)` = GPU마다 `-hwaccel d3d11va -hwaccel_device <DXGI 번호>` (ffmpeg 번호와 같은 차례 — 개발 PC에서 0·2 확인,
  없는 번호는 기본 장치로 그냥 됨), Linux는 `-hwaccel auto`. `DecodeAsync(logger, path, attempt, failure)`: 차례로 해 보고 모두 안 되면 CPU,
  안 된 GPU는 다른 GPU나 CPU로 됐을 때만 실패로 셈(깨진 영상은 안 셈) — GPU별 3번이면 그 GPU 그만, 어느 GPU로도 안 된 영상은 `FailedVideos`
  (다음부터 바로 CPU), 그런 영상 3개면 GPU 디코딩 끔. `Status()`에 쓰는 GPU 차례·마지막 실패(파일 — 오류). `TranscodeDecodeArgs(path)`(사본 변환·
  자르기는 첫 GPU). 인코더 시험 차례 = GPU 제조사 순(nvenc·qsv·amf) 뒤 나머지. `VendorRank` → `H264Encoder`가 하드웨어 MFT를 외장 → 내장
  차례로(VEN_xxxx 파싱), `HardwareEncoders`도 그 차례.
- 호출: `VideoAnalyzer.MeasureAsync`·`VideoImageSearch.ScanAsync`(한 프레임도 못 읽으면 실패)가 `DecodeAsync`, `VideoTrimmer.RunGpuAsync(ffmpeg, path, …)`.
- 확인: 에이전트(Windows·Linux) 빌드, 임시 콘솔로 개발 PC Adapters(NVIDIA 0 → AMD 2)·DecodeOptions·Status·MFT 차례(NVIDIA, AMD)·하드웨어 인코딩
  60장, ffmpeg d3d11va 장치 번호 지정(0·1·2 — 1은 같은 NVIDIA). 사용자 PC(가상 디스플레이)로는 못 봄.

### 0.9.1: 영상 분석 동시 실행 수·필터 스레드
사용자 보고: GPU 디코딩이 되자 GPU 사용률 60%+인데 분석 속도는 그대로. → 같은 ffmpeg(서버 패키지 tools/ffmpeg 9.0.2 gyan essentials)로 1080p30
2분 8Mbps 영상·꼭짓점 영역 측정 (scratchpad bench): ffmpeg 하나 기준 디코딩만 1.6초, +자르기·펴기·축소 2.1, +밝기 통계 2.5, +윤곽(edgedetect)
·통계 5.0, 전체 5.3초 — 시간의 약 70%가 디코딩 뒤 CPU 측정 필터(특히 edgedetect, 프레임마다 차례로). GPU 디코딩은 CPU 시간(34→22초)만 줄이고,
1080p 프레임을 GPU→CPU로 내려받는 비용으로 강한 CPU에선 오히려 조금 느림. GPU %는 디코딩 엔진일 것.
- 효과 없던 것: filter_threads 1(2배 느림), scale_d3d11(텍스처 생성 오류), scale_cuda(더 느림), 필터 두 갈래 출력(6%), edgedetect planes=y(값 같고 시간 같음).
  h264_cuvid -resize는 디코딩만 빠름(NVIDIA 전용, 필터 몫은 그대로).
- 바꾼 것 `VideoAnalyzer`: `Workers` = 논리 코어/2 (1~8, 전엔 최대 4) · `FilterThreads` = 논리 코어/Workers (1~3) → ffmpeg 인자 `-filter_threads`·
  `-filter_complex_threads` (기본은 ffmpeg마다 코어 수만큼이라 넘침). 측정: 24스레드 4개·기본 1355 → 8개·3개 1616 fps(CPU 디코딩, +19%), GPU 1207 →
  1296(+7%) / 16스레드로 제한 1143 → 1379(+21%), GPU 1152 → 1299(+13%) / 8스레드 748 → 786, GPU 913 → 976. 결과 값은 같음.
- 더 빠르게 하려면(사용자에게 제안, 보류): ffmpeg는 풀고 줄이기만, 밝기·차이·윤곽은 에이전트가 여러 프레임 동시에 SIMD로 (2~4배 예상, ffmpeg
  signalstats·edgedetect 계산을 그대로 옮겨 값 맞추기가 큰 일).

### 0.9.2: NVIDIA cuvid로 화면 영역 자르기·줄이기까지 GPU에서 (영상 분석)
사용자 보고: 0.9.1 뒤에도 전혀 빨라지지 않음, CPU 90~100% · GPU 60%+ — CPU와 GPU를 둘 다 쓰면 두 배는 빨라야 하지 않나.
→ 답: 프레임마다 GPU 디코딩 → CPU로 내려받기 → CPU 측정 필터를 차례로 거치므로 CPU가 100%면 그게 속도를 정함 (GPU 여유는 못 씀).
CPU 일을 줄여야 함: 1080p 프레임을 통째로 내려받고 CPU에서 자르고 640으로 줄이던 일을 NVDEC 디코더가 하게 함.
- 측정(scratchpad ff/bench2.ps1, 서버 패키지 ffmpeg 9.0.2, 1080p30 2분 8Mbps, 꼭짓점 영역): `-c:v h264_cuvid -crop 위x아래x왼쪽x오른쪽 -resize 640xH`
  → CPU 시간 34초(d3d11va)·40초(CPU) → 17.5초 (16스레드 제한, 8개 동시), 초당 1266(d3d11va)·1356(CPU) → 1730 프레임 (+37%) /
  8스레드 4개: 988·794 → 1282 (+30%). 값 차이(30초 비교): 밝기 평균 0.04·프레임 차이 0.02·윤곽 0.1 (0~255), 칸 윤곽 최대(정수) 최대 3 — 검출엔 무관.
  scale_d3d11은 이 ffmpeg에서 텍스처 생성 오류(옵션은 width/height/format), scale_cuda는 느림 → 안 씀.
- `FfmpegGpu`: `DecodeKind`(Hwaccel·Cuvid) · `DecodeOption`(+Kind, CudaIndex = NVIDIA 장치 차례, Key = 방식:장치 — 실패를 방식마다 셈) ·
  `DecodeOptions(path, cuvid)` NVIDIA면 cuvid 먼저 그다음 d3d11va · `CuvidDecoder(codec)`(h264·hevc·av1·vp9·vp8·mpeg1/2/4·mjpeg·vc1) ·
  `DecodeAsync(…, attempt(DecodeOption?), failure, cuvid)`(CPU면 null) · Status에 'NVIDIA …, 분석은 영역 자르기·줄이기까지 GPU'.
- `VideoAnalyzer`: probe의 Height·Codec을 넘김 · 베젤 없고 cuvid 코덱이면 cuvid 시도 · cuvid면 입력 `-c:v X_cuvid -gpu N -crop … -resize …`
  + 필터는 `Region.WarpFilter`(펴기·안쪽 자르기만, 직사각형이면 null) · `Region.GpuCrop(w,h)`(짝수 픽셀, 꼭짓점은 640폭까지만 줄임, 직사각형은 320폭)
  · `Filter` = crop + shrink + WarpFilter. 이미지 찾기·사본 변환은 d3d11va만(cuvid 아님).
- 확인: 에이전트(Windows·Linux) 빌드, 임시 콘솔로 실제 `MeasureOnceAsync`를 방식마다(cuvid·NVIDIA d3d11va·AMD d3d11va·CPU) — 프레임 900·시각 같음,
  값 차이 위와 같음. 사용자 PC(GTX 1660 SUPER)로는 못 봄 — NVDEC가 그 PC의 상한일 수 있음.

### 0.9.3: GPU 디코딩 실패 세기(영상 단위) · 중간에 멈춘 GPU 디코딩은 다시
사용자 요청: 속도 관련 코드 전체 리뷰 → 두 가지 결함을 찾아 고침 (확인 뒤 릴리즈).
- 결함 1: 실패를 구간마다 셌다 — 영상 하나의 구간 8개가 동시에 실패하면 바로 8 ≥ 3이라 그 GPU 방식이 에이전트 끝까지 꺼짐 (NVDEC가 못 푸는
  10비트 H.264 하나로 cuvid 영구 중단), cuvid 실패·d3d11va 성공인 영상은 구간마다 cuvid를 다시 시도. 고침 `FfmpegGpu`: `FailedOptions`("방식|영상" → 오류)에
  `TryAdd`로 처음 한 번만 `AdapterFailures`에 세고(이후 동시 구간은 무시), `DecodeOptions(path)`는 그 영상에서 실패한 방식을 뺌. `FailedVideos`도 TryAdd.
  이제 MaxAdapterFailures·MaxVideoFailures = 영상 개수.
- 결함 2: ffmpeg가 오류로 끝나도 프레임이 있으면 성공 — GPU 디코더는 깨진 패킷에서 멈추기도 해 프레임이 빠진 구간이 들어갔음. 고침
  `VideoAnalyzer.MeasureOnceAsync`: GPU 시도(strict)는 종료 코드 ≠ 0이면 실패(다음 GPU → CPU가 구간을 다시), 또 길이를 아는 구간에서 마지막 프레임이
  구간 앞 절반(start + length/2 − 1)에도 못 미치면 `FfmpegGpu.DecodeIncompleteException` — 이건 파일이 끊긴 것일 수도 있어 그 영상의 다음 구간만
  그 방식을 건너뛰고(FailedOptions) GPU 고장(AdapterFailures·FailedVideos·_decodeOff)으로는 세지 않음(`Record`의 Broken=false). CPU(마지막)는 그대로 부분 결과.
  절반까지만 보는 이유: 가변 프레임 녹화의 긴 빈틈을 실패로 오인하지 않게. 뒷 절반에서 멈춘 경우는 못 잡음(한계).
- 확인: 임시 콘솔(scratchpad gtest, 리플렉션) — 실제 ffmpeg: 정상 영상 10~40초 cuvid·d3d11va×2·CPU 모두 900프레임, 24초에서 끊긴 MKV 10~60초는
  GPU 셋 다 DecodeIncomplete·CPU 421프레임, 끊긴 영상 10~20초·정상 영상 끝 구간 100~120초는 GPU 성공(오탐 없음) / 가짜 시도 8개 동시: cuvid만 실패
  영상 3개째에 cuvid 꺼짐(그 전엔 그 영상만 건너뜀), 못 채운 영상은 그 영상만 CPU·상태 변화 없음, 모든 GPU 실패 영상 3개째에 GPU 디코딩 꺼짐.
- 리뷰에서 남긴 것(안 고침): NVDEC가 상한이면(Video Decode 100%) CPU 디코딩 작업자를 섞어야 더 빨라짐(CPU가 병목일 땐 역효과라 자동 판단 필요) ·
  꺼진 GPU는 재시작까지 영구 · 같은 모델 GPU 2장은 하나로 합쳐짐 · cuvid -gpu 번호는 DXGI 차례(NVIDIA 1장이면 무관) · 4K 8개 동시 cuvid 메모리 ~2.4GB ·
  디코더 `-threads 2`면 CPU 디코딩 5% 더 빠름(측정, 사소).

### 0.9.4: 끊긴 Cycle에도 제외 구간 적용 · ATS Cycle 열 = CURRENT TC REPEAT (웹만)
사용자 보고: 테스트를 중간에 끊은 마지막 Cycle이 "모든 Cycle" 제외 구간에서 빠지지 않음 / ATS에서 Cycle은 ITERATION IN JOB이 아니라 CURRENT TC REPEAT 열.
- `videoExclude.ts` `spansOf`: 시작 스텝은 있는데 끝 스텝이 없는 Cycle(중간에 끊김·실패로 건너뜀)은 시작 스텝 ~ 그 Cycle 다음 행(다음 Cycle 시작)까지,
  마지막 Cycle이면 끝까지(Infinity). 전에는 구간이 통째로 빠져 끊은 뒤 화면(꺼진 화면 등)이 검출됐음. `stepEnd`: 걸린 시간 없는 마지막 행도 끝까지(전엔 길이 0).
  `ResultViewer` `excludeSpans`는 영상 길이로 자르고, `AnalysisChart` 빗금은 보이는 끝까지(canvas fillRect는 무한 값이면 안 그림). 제외는 브라우저에서만 적용.
- `resultCsv.ts` `parseAts`: Cycle 열 = I열 `CURRENT TC REPEAT`(이름으로 찾고 없으면 8번째 열), 표 머리글 CYCLE, 계획 Cycle 수 = H열 `TOTAL TC REPEAT`
  최댓값(`cycleTotal`, 표 위 "Cycle n / 계획"). B열 ITERATION IN JOB은 이제 표에 없음. `Reference/0.0.0meminfo…csv` 샘플은 ITERATION 1~6·TC REPEAT 1 고정이라
  Cycle 1개로 읽힘(사용자 정의대로). 자동 판별 정규식에 `current tc repeat` 추가. → **0.9.5에서 두 열 중 값이 올라가는 쪽을 쓰도록 바뀜** (아래).
- 확인: `tsc -b`·oxlint 32(기존), tsx 테스트(scratchpad exclude-test): 끊긴 마지막 Cycle·끝 스텝 건너뛴 중간 Cycle·정상 / 샘플·합성(TC REPEAT 1~3)·열 순서 바뀐 파일.
- 미해결(사용자 보고 "현재 테스트 중인 CSV가 로드 안 돼 예약을 못 함", 어느 화면인지 미확인): 녹화 중인 MKV(OBS, 길이·Cues 없음)는 결과 확인 영상 자리에
  "바로 재생할 수 없는 영상 — 영상 길이 정보가 없습니다(녹화가 비정상 종료…)" 안내가 뜸. 로컬 재현(ffmpeg -re로 쓰는 중인 mkv): 에이전트 probe `Duration: N/A`,
  [변환 시작]은 지금까지 녹화된 부분 사본(remux 성공), [원본 재생]도 Chrome이 재생·길이 파악. 화면 영역을 지정해야 예약되므로 둘 중 하나를 골라야 함.
  후보 개선: 수정 시각이 최근이면 '녹화 중' 문구로 나누고 사본 자동 생성 · 에이전트 분석은 길이를 모르면 구간 하나(병렬 없음)라 마지막 Cluster 시각으로 길이 추정.

### 0.9.5: 영상 분석 그래프 [▶ 따라가기] 토글 · ATS Cycle 열 자동 선택 (웹만)
사용자 요청: 그래프가 재생 중에 재생 위치로 따라가지 않게 할 수 있어야 함 — 따라가기 버튼을 두고, 켜면 재생을 따라가고 끄면 재생 중에도 스와이프(드래그) 가능.
- `VideoAnalysis.tsx` `AnalysisChart`: 범례 줄 끝에 `[▶ 따라가기]`(`.rv-va-key.rv-va-follow`, aria-pressed) 추가. 상태는 localStorage `results.va.follow`(기본 켬).
  따라가기 effect는 켜져 있을 때만, 그리고 끌고 있는 동안(`dragRef.current.moved`)은 건너뜀. 켤 때 재생 위치가 범위 밖이면 바로 데려옴.
  끄면 재생 중에도 드래그·휠(Shift+휠·가로 휠)로 자유롭게 이동. 전체 보기(view null)면 원래 따라갈 것이 없음.
- `styles.css`: 토글은 테두리로 범례 키와 구분, 꺼져도 취소선 없음. `en.ts`: "▶ 따라가기"·안내 문구.

사용자 정정(ATS Cycle): Cycle은 `ITERATION IN JOB`(B열)과 `CURRENT TC REPEAT`(I열) 둘 중 하나 — 파일마다 되풀이되는 쪽이 다르고 다른 쪽은 1 고정. 값이 1씩 올라가는 열을 쓴다.
- `resultCsv.ts` `parseAts` → `pickCycleColumn(data, [tcRepeatAt, iterationAt])`: 데이터 줄을 먼저 모은 뒤 두 열의 값 변화를 센다. 바뀌는 열을 고르고,
  둘 다 안 바뀌면(한 Cycle만 돌고 끊김) TC REPEAT, 둘 다 바뀌면 바뀔 때마다 1씩만 올라가는 쪽(되돌아가는 1,2,3,1,2,3은 같은 Cycle 이름이 떨어져 두 번 나와
  Cycle 단위 처리가 어긋남), 그래도 같으면 더 많이 바뀐 쪽. 고른 열의 머리글이 CYCLE. 계획 Cycle 수(`cycleTotal`)는 TC REPEAT이 Cycle일 때만
  `TOTAL TC REPEAT`, ITERATION이면 총 횟수 열이 없어 없음(표 위 "Cycle n"만). 샘플 `0.0.0meminfo…csv`는 이제 ITERATION으로 Cycle 6개.
- 확인: `tsc -b`·oxlint 32(기존), tsx 테스트(scratchpad exclude-test/ats.test.ts, 21개): 샘플 / TC REPEAT 반복 / ITERATION 반복 / 둘 다 고정 / 둘 다 바뀜 /
  열 순서 바뀜 / 이름 없는 머리글(정해진 자리 B·I).

### 0.9.6: 영상 분석 판정 — 깜박임 = 급격히 꺼졌다 2초 안에 켜짐 · 더 오래면 검은 화면 (웹만)
사용자 보고: 그래프에서 급격히 꺼졌다 켜진 구간 둘이 깜박임으로 안 잡힘 (서서히 꺼진 셋째는 안 잡혀도 됨). 원본 영상(`D:\1.Video\2026-10-26 16-25-17.mkv`,
12분 30fps, OBS 합성 — 왼쪽 웹캠 속 AIVI2 화면 + 오른쪽 ATS 창)을 받아 로컬에서 에이전트와 같은 ffmpeg 측정 → 웹 Detector로 재판정해 원인 확인.
- 원인 (scratchpad `va/`: `measure.sh` 측정, `analyze.ts` 재판정·그래프 PNG): Cycle 3개마다 ① 3.1~3.4초 ② 1.2~1.4초 꺼짐이 있는데 밝기 63 → 19(기준 밝기 17.3)
  → 32(절반으로 켜짐). 옛 깜박임은 0.6초 안에 원래 밝기 ±10%로 돌아와야 해 둘 다 탈락. 검은 화면은 윤곽까지 없어야 하는데 가운데만 검고 왼쪽·아래
  아이콘이 남아(칸 윤곽 9~10, 완전히 꺼지면 3, 기준 ≤6) "아이콘만 남은 어두운 테마 = 켜진 화면" 설계에 걸려 탈락. 처음 잰 화면 영역에 위 선반이 섞이면
  꺼져도 칸 윤곽 12라 검은 화면이 하나도 안 잡혔음 — 영역 지정이 중요(사용자 분석에서는 검은 화면이 잡혔으니 영역은 맞음).
- 사용자 결정: 깜박임은 2초 안팎의 진짜 깜박임, 그보다 길면 검은 화면, 둘 다 몇 초였는지 표시.
- `videoDetect.ts` 새 규칙 (rkfa `blinks` 삭제, `Detector.off`·`dropAt`·`closeOff`·`black`):
  - 꺼진 수준 = 밝기가 꺼진 수준(기준 밝기와 차이 ≤ cOff, 검은 화면과 같은 기준) + 색 없음. 윤곽까지 없으면 완전히 꺼짐(`isBlank`, 정지 구간 제외용 그대로).
  - 꺼진 수준이 이어지는 구간(`off`)을 두고 첫 프레임에서 급격히 꺼졌는지(`dropAt`): 그 전에 켜져 있던 동안(최대 2초, 되짚어 앞 3프레임이 1 넘게
    어두워지면 멈춤 = 그 전 켜짐의 시작)의 가장 밝은 값보다 25%(최소 12) 넘게 어두워지기 시작한 지 0.3초 안에 꺼진 수준에 들면 급격.
    (처음엔 "0.3초 전 프레임보다 25%"로 했더니 2초 선형 페이드도 끝부분은 0.3초에 15 떨어져 급격으로 잡혀 고침.)
  - 구간이 끝나면(`closeOff`): 급격 + 다시 켜져 끝남 + 2초 이하 → 깜박임(`Blink.dur` = 어두워지기 시작 ~ 다시 켜짐, 돌아온 밝기 무관, 첫 깜박임부터
    3초 안은 한 묶음 — 묶음은 3+2초 지나서 닫음) · 급격 + 2초 넘음 → 통째로 검은 화면(`BlackInfo.sudden`, 아이콘 남아도) · 그 밖(서서히 꺼짐)은
    완전히 꺼진 조각(`fulls`)만 0.3초 이상이면 검은 화면(옛 규칙 그대로). 영상이 끝나며 끊긴 구간은 깜박임이 아님.
  - 전환: 깜박임 안(어두워지기 시작 ~ 다시 켜진 프레임)의 큰 차이는 빼고(켜지는 프레임은 그 자리에서, 꺼지는 프레임은 묶음이 닫힐 때 `flSpans`),
    검은 화면의 꺼짐·켜짐은 전환으로 셈(그대로). `MIN_BLACK_S`를 export해 `videoExclude`가 같이 씀.
  - 글: 탭 규칙 문구, 검은 화면 "n초 동안 꺼짐 (급격히 꺼짐, 아이콘·글자 윤곽 남음)", 깜박임 "최대 n초 꺼졌다 켜짐". `en.ts` 같이.
- 확인: `tsc -b`·oxlint 32(기존). 합성(scratchpad va/synth.test.ts 10개): 1초 꺼짐 → 깜박임 / 3초 아이콘 남은 꺼짐 → 검은 화면 sudden / 2초 페이드 뒤
  3초 꺼짐 → 완전히 꺼진 부분만 검은 화면·깜박임 아님 / 페이드+아이콘 → 없음 / 0.5초 꺼졌다 어둡게 켜짐 → 깜박임 / 번쩍임 → 전환 / 0.3초×2 → 묶음 2회.
  실영상(`analyze.ts`): 깜박임 3:13(1.33초)·4:51(0.4)·4:56·5:04·6:32(1.17)·6:36(2회)·6:40·9:51(1.27), 검은 화면 2:50(3.07초, 아이콘)·6:10(3.23)·
  9:28(3.37)·4:59(2.97, 완전히)·3:35/6:54(72초)·6:15(15초)·0:15(테스트 전 74초). 4:52.2·8:08.1은 0.5초쯤 페이드로 어두워진 것이라 깜박임 아님(규칙대로).
- 남은 생각: 깜박임 최대 2초·급격 0.3초는 상수. 사용자가 조정하고 싶어 하면 정지 기준처럼 입력 칸으로.
- 정정 (0.9.7에서): 위 "4:52.2는 0.5초쯤 페이드로 어두워진 것"은 틀림. 서서히 줄던 건 꺼지기 전 빛 번짐이고 꺼짐 자체는 2프레임 만이었다.

### 0.9.7: 꺼짐 판정 = 1차 밝기 → 2차 윤곽 → 길이 · 급격 판정은 마지막 급강하부터 (웹만)
사용자 보고·결정: 4:52.1 깜박임이 0.4초 검은 화면으로 잡힘 / 그라데이션 없는 화면 전환은 깜박임과 어떻게 구분하나 → "검은 화면도 꺼진 수준까지
닿아야 검은 화면. 깜박임·꺼진 화면 모두 1차로 밝기로 거르고 윤곽까지 보고 최종 판단".
- 원인(4:52): 0.9.6 `dropAt`이 켜져 있던 동안 가장 밝은 값(직전 깜박임 직후 빛 번짐 56)에서 25% 어두워진 때부터 재서, 빛 번짐이 서서히 줄던
  0.4초까지 넣어 '서서히'로 봄 → 서서히 경로의 완전히 꺼진 조각(0.4초 ≥ 0.3초)이 검은 화면. 프레임: 부팅 로고가 가운데에서 오른쪽으로
  바뀌는 사이 밝기 33 → 18(2프레임), 0.4초 꺼졌다 30으로 켜짐. Cycle 1·3 부팅은 같은 자리에서 서서히 0.1초만 어두워짐.
- 화면 전환과 깜박임: 검게 되지 않는 바로 전환은 원래 꺼진 수준에 안 닿아 전환으로만 잡힘. 헷갈리는 건 ① 어두운 화면(어두운 테마·로고)으로
  바로 바뀜 — 밝기만 꺼진 수준(8:08 로고 화면 0.47초, 0.4초에 걸쳐 어두워져 급격 한도를 0.1초 차이로 넘어 안 잡혔을 뿐) → 2차 윤곽으로 막음,
  ② 실제로 검게 거치는 전환(부팅 단계·화면 모드) — 화면 신호로는 구분 불가 → Cycle 반복 여부로 (아래 검토).
- `videoDetect.ts` (`Detector.onset`·`edgeRef`·`closeOff`·`black`, `Onset`·`OffRun`):
  - 1차 밝기: 꺼진 수준(기준 밝기와 차이 ≤ cOff, 기준 밝기를 모르면 평소의 절반 아래) + 색 없음 (그대로).
  - 2차 윤곽: 꺼진 구간을 열 때 꺼지기 전(어두워지기 시작 전 최대 1초, 켜져 있던 동안) 칸 윤곽 중앙값(lit)의 50%(`OFF_EDGE_REL`) 이하.
    완전히 꺼진 기준(gOff, 옛 에이전트면 평균 윤곽 blankE) 이하면 늘 통과. 구간이 이어지는 동안 같은 기준이고, 넘으면(윤곽이 돌아옴) 구간 끝.
    시험 영상: 실제 꺼짐 14건 윤곽 비율 ≤ 0.33, 8:08 어두운 로고 화면 1.31(윤곽이 오히려 늘어남).
  - 급격(`onset`): 꺼진 첫 프레임보다 (켜져 있던 동안 최대 밝기의 25%, 최소 12) 넘게 밝았던 **마지막** 프레임에서 0.3초 안에 꺼짐.
    전에는 최대 밝기에서 25% 어두워진 때부터 재서 서서히 어두워지던 부분까지 들어갔음.
  - 길이(`closeOff`): 급격이면 어두워지기 시작한 프레임(i0)부터. 2초 넘으면 검은 화면(급격·서서히 모두, `sudden` 표시), 2초 이하이고 급격히
    꺼졌다 켜졌으면 깜박임, 2초 이하이고 서서히면 판정 안 함 (전에는 완전히 꺼진 부분이 0.3초 이상이면 검은 화면 — "그 이상은 블랙스크린"에 맞춤).
  - `BlackInfo.grid/edge`에 off(2차 기준)·full(완전히 꺼짐 기준)·lit(꺼지기 전). 글: "n초 동안 꺼짐 (급격히 꺼짐, 아이콘·글자 윤곽 남음)",
    "윤곽이 가장 많은 칸 v (꺼짐 기준 ≤x · 꺼지기 전 y)", 탭 규칙 문구, `en.ts`. `MIN_BLACK_S`(0.3)는 이제 제외 구간으로 잘려 남은 조각에만.
- 확인: `tsc -b`·oxlint 32(기존). 합성(scratchpad va/synth.test.ts 13개): 1초 급격 → 깜박임 / 3초 급격+아이콘 → 검은 화면 / 서서히 3초(완전히·아이콘)
  → 검은 화면 / 0.5초 → 깜박임 / 번쩍임 → 전환 / 0.3초×2 → 묶음 / 어두운 화면으로 바로 1·3초(윤곽 그대로)·어두운 로고(윤곽 늘어남) → 없음 /
  서서히 1초 → 없음. 실영상(`analyze.ts`, 0.9.6과 diff): 4:51 깜박임 + 4:52 검은 화면 → 깜박임 묶음 4:51.17~4:52.60(2회, 최대 0.43초),
  4:52.20 전환 빠짐, 나머지는 시작·끝 1프레임 차이뿐. exclude-test(5)·ats(21) 그대로.

### 0.9.7 (이어서): 기준 Cycle 대비 이상 판정 · 화면 깨짐 (웹 + 에이전트)
사용자 요청·결정: 첫 Cycle은 사용자가 정상 동작을 확인한다. 스텝과 첫 Cycle 결과로 이후 Cycle의 이상 증상(깜박임·지연·검은 화면·화면 깨짐 등)을
판단 → 검토안(1단계 웹 사건 대조 + 2단계 에이전트 축소 이미지) "전부 진행 후에 릴리즈". 목록은 숨기지 않고 정상 표시 + "이상만 보기"로 거름.
- 사전 시험(scratchpad va/golden.ts, Cycle 시작 = 부팅 시각으로 맞춤): 정상인 Cycle 3은 화면 전환 11개가 모두 첫 Cycle과 0.2초 안(중앙값 0.07초)
  → 꺼짐 짝 ±1초·지연 0.5초 기준이면 정상 흔들림과 갈림.
- 에이전트 `VideoAnalyzer.cs`: 측정 그래프를 `split`으로 둘로 — 측정(그대로) · 축소 이미지(`select`로 0.2초 칸마다 첫 프레임 → 16×9 회색 →
  `thumb.raw`, 그 시각은 `signalstats,metadata=print:file=thumb.txt`). 늘 `-filter_complex` + 출력 둘(`-map [out] -f null -` · `-map [thumb] -f rawvideo
  thumb.raw`), CPU·cuvid·베젤 경로 모두. `ReadThumbs`(txt 시각과 raw를 차례로 짝, 끝이 잘리면 둘 다 있는 데까지), `MeasureVideoAsync`는 구간
  경계에서 0.1초 안에 겹친 것만 빼고 붙임 — 처음엔 C#에서 floor(t/0.2)로 칸을 다시 나눴더니 소수 오차(15.2/0.2 = 75.999…)로 ffmpeg와 칸이 달라
  18%가 빠짐. select에도 `+0.0001` 여유를 줘 칸 경계에 딱 맞는 프레임이 새 칸으로(간격이 0.167·0.233으로 흔들리던 것). `GetChunks`: 예산을
  바이트(1MB)로, 보내는 프레임 시각 안의 축소 이미지를 함께(`ThumbRange`). 데이터: 프레임 31바이트 + 축소 이미지 152바이트/0.2초(시간당 약 2.7MB).
- 공용 `Contracts.cs` `VideoAnalysisChunk.Thumbs`(byte[]?, 맨 끝 기본값 null — 옛 에이전트·옛 서버와 섞여도 없음으로). 웹 `api.ts` `thumbs`.
- 웹 `videoAnalysisState.ts`: `VideoFrames.tn/tt/tp`(축소 이미지) · `appendThumbs` · 설정 `refCycle`·`delayS`(서버 작업 params에 함께 → 다시 열 때·예약 분석도).
- 웹 `videoCycle.ts` `compareCycles(rows, position, frames, results(제외 구간을 뺀 검출), {diff, delayS, refCycle}, excluded)` 새로:
  - 맞춤: 스텝 키(`stepKeys`) + 스텝 시작부터 오프셋 → 기준 Cycle 벽시계(ms) (`toRef`·`fromRef`). 스텝 구간은 모든 행(짧은 스텝 포함).
    제외 구간은 반열린 구간 [a, b) (테스트 시작 경계에 딱 맞은 꺼짐이 빠지던 것).
  - ① 꺼짐: 깜박임 묶음·검은 화면을 기준 Cycle 같은 자리 ±1초와 짝 → 길이 차 > max(0.5초, 30%)면 길어짐/짧아짐, 아니면 정상 표시(`marks`).
    짝이 없으면 추가, 기준에만 있으면 빠짐(이 Cycle에 같은 스텝이 있고, 제외 구간 밖, 잰 범위 안일 때만).
  - ② 반응: 화면 전환을 순서를 지키는 정렬(DP: 짝 값 = 어긋난 초, 짝 없음 = 5, −1~+10초만 짝, 표가 400만 칸 넘으면 차례로)로 →
    지연 기준(기본 0.5초) 넘게 늦으면 지연, 기준 전환이 짝이 없으면 반응 없음(그때 이 Cycle이 꺼져 있었으면 꺼짐으로 이미 나오므로 빼고,
    정지 중이었으면 표시). 꺼짐 시작·끝 ±0.6초 전환은 ①에서 보므로 뺌 (0.3초면 켜지며 잡힌 전환이 한쪽만 빠져 반응 없음 오탐).
  - ③ 화면 멈춤: 이 Cycle의 정지 구간 중 기준도 정지였던 비율 < 50%.
  - ④ 화면(0.2초 칸, 기존 밝기·평균 색 + 축소 이미지 `cellDiff`: 기준을 이 Cycle 밝기에 맞게 이득·오프셋 맞춤 → 가장 다른 20% 빼고 다시 맞춤 →
    차이 > 24인 칸). 밝기·색이 기준을 넘거나 칸 절반 넘게 다르면 화면 다름, 3칸 이상 절반 이하면 화면 깨짐(몰린 곳 3×3 이름 · 칸 격자).
    꺼짐 동안과 화면이 움직이는 칸(칸 평균 프레임 차이 > 평소 변화×4, 최소 1 — 멈춘 화면 0.25~0.35, 부팅 로고 애니메이션 3~12. 애니메이션
    속도가 Cycle마다 달라 화면 깨짐 오탐)은 칸 비교 안 함. `cellDiffQuick`(평균만 맞춰도 다 24 이하면 끝) + 가장 비슷한 칸부터 →
    10시간·50 Cycle 1.75초 → 0.1초. 꺼짐 구간 찾기는 이진 탐색.
- 웹 `videoDetect.ts`: 깜박임 뒤 여유(0.25초) 안의 큰 차이는 전환 후보와 전환 합치기 기준에서 뺌, 깜박임 확정 때 `trLast` 지움 — 전에는 깜박임
  직후 0.5초 안의 진짜 전환이 빠질 후보에 합쳐져 사라짐(시험 영상 5:05.17).
- 웹 `VideoAnalysis.tsx`: Cycle 비교 탭 = 기준 Cycle 고르기 · 밝기 차이 · 지연(초) · 종류 거르기(전체/꺼짐/지연·반응/화면) · "스텝 n개 비교"
  (옛 에이전트면 "화면 깨짐 못 봄"). 항목 = 종류(꺼짐 빨강 · 지연·반응 주황 · 화면 청록) + Cycle + 내용 + 화면 깨짐 칸 격자 + [기준 Cycle 보기].
  검은 화면·깜박임·정지 목록에 "기준 Cycle" · "기준 Cycle에도 있음" 표시, "이상만 보기"(localStorage `results.va.onlyAbnormal`)로 감춤.
  정지 판정 이름은 "화면 멈춤"("멈춤"은 이미 Stop 버튼 번역). 그래프 범례 "기준 Cycle 밝기". select는 기본 width 100%라 `width: auto`.
  `en.ts` 패턴 차례 주의: "{0}초"(초로 끝나는 글을 통째로 잡음)보다 꺼짐 글·"기준 Cycle {0} → {1}"을 먼저, "윤곽이 가장 많은 칸 … 꺼지기 전"을 옛 것보다 먼저.
- 확인: `tsc -b`·`npm run build`·oxlint 32(기존, 오류 0 — 매개변수 이름 `use`가 React 훅으로 오인돼 `keep`), 에이전트·Linux 에이전트·서버 빌드.
  에이전트 실제 실행(scratchpad harness: VideoAnalyzer를 그대로 돌려 웹처럼 조각 받기): 12분 영상 9초(cuvid), 프레임 21,154 · 축소 이미지 3,526개
  모두 0.2초 간격 · 가장 큰 조각 608KB · 스크래치 CPU 측정과 화소 평균 차이 0.8. ffmpeg 그래프는 CPU·cuvid 둘 다 손으로도 확인.
  합성(va/cycle.test.ts 18개): 꺼짐 길어짐·빠짐·추가 · 지연 +1초 · 반응 없음 · 화면 다름(밝기·무늬) · 화면 멈춤 · 화면 깨짐(왼쪽 위 5칸) · 정상 표시 ·
  기준 Cycle 2로 · 제외 구간 · 지연 기준 · 옛 에이전트. 실영상(va/golden-test.ts, Result CSV가 없어 4초 가짜 스텝·Cycle 199.03초 주기):
  Cycle 3 = 0건, Cycle 2 = 첫 Cycle에 없는 꺼짐 7건만(4:51.17 2회·4:56.63·4:59.27 2.97초·5:04.50·6:15.17 15.2초·6:36.30 2회·6:40.33).
  깨짐을 넣은 사본(va/measure2.sh corrupt2: 9:00 초록 상자 · 9:45 분홍 작은 상자 · 10:00 왼쪽 1/3을 55% 어둡게) → 화면 깨짐 3건(오른쪽 위 5칸 ·
  가운데 6칸 · 왼쪽 3칸). 정상 Cycle 3 vs 1 칸 비교: 583칸 중 0칸(4~44칸은 애니메이션 칸뿐 — 빼는 칸). 브라우저(임시 하네스, 지움):
  목록·표시·이상만 보기·기준 Cycle 바꾸기, English 남은 한글 0. 10시간 50 Cycle 0.1초.
- 남은 생각: 화면 깨짐 기준(칸 차이 24 · 3칸)은 이 영상 하나로 맞춘 값 — 실제 결과를 보며 조정. 어두운 화면 위를 조금 어둡게 한 깨짐은 칸이 적게 잡힘.
  시계·지도처럼 Cycle마다 다른 동적 내용은 화면 깨짐으로 나올 수 있음 → 제외 구간으로. 실제 Result CSV(스텝)로는 아직 못 돌려 봄.

### 0.9.8: 깜박임 = 떨어지는 구간 0.15초 · ATS 머리말 줄 수 · 프로젝트별 검출 기준값 · 메모 구간 · 사이드메뉴 탭 (서버(웹) 업데이트)
사용자 요청 (2026-10-27): ① 1:34.6 서서히 어두워진 것이 깜박임으로 잡힘 ② 첫 Cycle에서 문제 구간을 골라 메모("부팅로드 중") → 이후 Cycle의
일치하는 문제는 제외 ③ 검출 기준값을 프로젝트마다 (장치 사양에 맞게) ④ 일부 ATS 머리글이 필드 값으로 ⑤ 채팅·메모·진행 PiP를 사이드메뉴 탭으로,
Result 사이드바를 PC Manager와 같게(접기·폴더·생성·이동), 메모 새 탭으로 열기.
- ① 원인: 0.9.7 "급격" = 꺼진 첫 프레임보다 need 넘게 밝았던 마지막 프레임에서 0.3초 안. 1:34.6은 화면 페이드(8프레임 0.27초, 31→18 고르게)인데
  사용자 영역에서는 글자 윤곽이 끝까지 남아 꺼진 첫 프레임이 페이드 끝(18.7)으로 밀려 → 고원(30.9)에서 0.27초 → 급격 → 깜박임 1:34.60~1:34.93.
  (스크래치 영역으로는 안 생김 — 밝기 ×1.093·윤곽 94.81초까지 유지로 재현: va2/analyze-hold*.ts.) 이 영상의 실제 깜박임·꺼짐 18건은 모두 0.1초(3프레임) 안.
  고침(`videoDetect.ts` `ramp`): 꺼지기 직전 0.3초 ~ 뒤 2프레임에서 가장 크게 떨어진 프레임을 가운데로, 그 25%(최소 1) 넘게 떨어진 프레임이
  이어진 곳(한 프레임 멈칫은 이어 봄 — 반쯤 꺼진 두 단계 6:09.90) = 떨어지는 구간, 이게 0.15초(+0.001) 안이고 need 넘게면 급격, i0 = 그 시작.
  확인: 합성 18(va/synth2.test.ts: 0.25초 밝은 페이드·0.27초 어두운 페이드(윤곽 유지)·0.4초 페이드 → 없음, 3프레임 꺼짐·반쯤 꺼진 2프레임 → 깜박임 —
  옛 규칙은 페이드 셋 모두 깜박임), 실영상은 개수·전환 그대로, 시작만 1~2프레임 앞(떨어지기 시작한 프레임). golden-test 그대로(Cycle 2 = 7건).
- ④ 원인: `parseAts`가 앞 6줄을 머리말로 못 박음 → 머리말이 한 줄 짧은 파일은 첫 데이터 줄이 열 이름 + 표에서 빠짐(CYCLE·STEP RESULT만 정상 —
  자리 고정 이름). 고침: 첫 열이 시각으로 읽히는 [ ] 줄 = 첫 데이터, 그 위 내용 있는 줄(열 24개 넘음) = 열 이름. `detectResultMode`도 머리말
  (Script Name·START TIME) 뒤 [시각] 줄로. 확인(hdr/header.test.ts 25): 샘플 원본·앞 빈 줄 없음·열 이름 앞 빈 줄 없음·머리말 2줄 더·열 이름 없음.
- ③ 서버 `AnalysisDefaultsStore`(`analysis-defaults.json`, 프로젝트 id → 이름→값, 기본값과 다른 것만) · `GET/PUT /api/analysis-defaults/{projectId}`
  (없는 프로젝트 404, 무한대·빈 이름 버림, 비우면 지움). 웹 `analysisDefaults.ts`(`DetectParams` = `DetectorParams`(videoDetect) + `CycleParams`(videoCycle)
  + 새 분석의 처음 값 정지 기준·밝기 차이·지연, `PARAM_GROUPS` 23개 · `useProjectParams` · `formKey`), `AnalysisDefaultsForm.tsx`(분석 패널 [⚙ 기준값] 창,
  설정 화면 "영상 분석 기준값" — results 권한). `Detector(staticS, params)` · `compareCycles` opts에 CycleParams. `useVideoAnalysis`: 기준값이 오거나
  바뀌면 받은 프레임으로 다시 판정, 이 분석에서 정지 기준·밝기 차이·지연을 아직 안 정했으면(되살린 설정 없음·사용자가 안 바꿈) 프로젝트 값으로
  (`changeStatic(s, auto)` — 가장 작은 값으로 올리는 것은 사용자 변경 아님). 탭 규칙 글은 기준값 숫자로(`rulesOf`, en.ts TEMPLATES 맨 앞).
  `api.ts` `setCurrentProject`(App이 그리는 중에 — 효과로 하면 자식의 첫 효과가 프로젝트를 모름). 파일 이름: Windows는 대소문자만 다른
  `AnalysisDefaults.tsx`·`analysisDefaults.ts`를 같은 파일로 봄 → 화면은 `AnalysisDefaultsForm.tsx`.
- ② 메모 구간(`videoMemo.ts`): `MemoSpan` = 메모 + 시작·끝 스텝(ResultRow.index) + 스텝 영상 위치부터 초 + 모든 Cycle. `placeMemos`: 고른 Cycle은
  그대로, 다른 Cycle은 같은 시작 스텝 → 그 뒤 첫 같은 끝 스텝의 같은 오프셋에서 밝기 흐름(0.1초 칸, 각자 평균을 뺀 차이 + 옮김 0.3/초)이
  가장 비슷한 곳을 ±5초 안에서 (`bestShift` — 부팅처럼 Cycle마다 몇 초씩 다른 곳). `applyMemos`: 메모 구간 안에 든 부분을 고른 Cycle 검출과
  같은 종류·구간 시작부터 ±tol(꺼짐 짝 허용)·비슷한 길이(꺼짐 길이 기준)로 짝 → 그 부분만 빼고(검은 화면·정지는 밖으로 남는 부분 남김,
  깜박임 통째), 전환은 고른 Cycle에도 ±0.5초 → 뺌. 고른 Cycle에 없던 것(새 깜박임)은 남김 → Cycle 비교에서 추가로 나옴. Cycle 비교 ④ 화면 비교는
  메모 구간 안 안 함(`quiet`, 합쳐 정렬 → 이진 탐색: 150곳에서 308 → 93ms). 상태·서버 작업 params에 `memos`. 화면: 분석 패널 [📝 메모 구간] →
  줄(시작·끝 ◂ 지금, 메모, 모든 Cycle, 추가·바꾸기, 목록 ✎ ✕ · Cycle n곳 · 뺀 검출 n개), 그래프를 끌면 구간(고르는 중일 때만, 아니면 좌우 이동),
  초록 띠·위 줄·메모 글, 범례 "메모 구간", 검출 목록 줄 끝 📝(앞뒤 0.5초), "메모 구간으로 뺀 검출 n개".
  확인(memo/memo.test.ts 실영상 7개, 스텝 어긋남 0·+1.5·−2.5·+4초): 첫 Cycle 1:29~1:47 "부팅 로드 중" → Cycle 2·3 자리가 부팅 끝 기준 0.2초 안
  (옮김 −1.4·+2.6·−3.9초로 되돌림), 첫·셋째 Cycle 구간 안 전환 모두 빠짐, 부팅 검은 화면은 메모 시작에서 잘림, Cycle 2의 새 깜박임 3·검은 화면 1은
  남고 Cycle 비교에서 추가. 브라우저(임시 하네스 web/harness-va*, 지움): 끌어 고르기·📝·기준값 창 저장 → 다시 판정(깜박임 최대 3.5초 → 검은 화면 8→4),
  English 남은 한글 = 사용자 메모뿐(translate=no).
- ⑤ 사이드메뉴 (작업 나눔 — 하위 작업자): `sideHubState.ts`(PiP 안에 있던 채팅·메모·진행 상태를 App에서 한 번), `SideHub.tsx`(보이는 조각·진행 목록),
  `PcTree.tsx` 맨 위 `◂ | PC | 채팅 | 메모 | 진행상황`(배지, 마지막 탭 `pcm.side.menu`, 접으면 💬📝⏳ 아이콘, 오른쪽 끝 끌어 폭 — PC·진행 260 / 채팅·메모
  460 따로 저장), `variant="results"`(Browser/Remote·공유 서버/즐겨찾기 없음, PC 누르면 고름, `renderAgentExtra`·`headExtra`·`emptyText`),
  `sideCollapse.ts`(두 화면이 같은 접힘 `pcm.explorer.collapsed`), `ResultsPage.tsx` 목록 → PcTree(⏰·분석 %/완료·형식·▶ 최신·"결과 폴더를 정한 PC만"·
  PcInfoPanel 그대로). PiP: PC Manager·Result에서는 사이드바가 가려질 때만(원격 창·전체 화면·결과 확인 화면 `body.rv-open`), 그 밖(State·History·
  Setting·?result= 탭)은 전과 같음. 메모 새 탭: `notesTab.ts` `?notes=<id>`(먼저 저장 후 열기, 주소·제목이 고른 메모를 따라감).
  독립 검토 7건 반영: 로그인 전에는 허브 알림을 끔(로그인 전엔 내 작업을 몰라 모든 사람의 분석 완료가 울림 — `active = !!auth && …`),
  채팅 쓰던 글은 방마다 패널 밖(`ChatPanel` `savedDrafts`) · 사이드바에서 마지막으로 연 메모(`NotesPanel` `lastOpenNote`) — 패널이 이제 탭 바꾸기·
  접기·PiP로 옮김에 자주 다시 붙음, 채팅 알림은 나·방 바꾸기를 ref로(구독이 로그인 전 값에 묶임), 같은 그리기 안 보여 주기 요청은 user를 남김,
  Result PC 줄 키보드(Tab·Enter), 메모 탭의 처음 열 메모는 서버 목록을 받은 뒤(변경 알림으로 한 개만 든 목록에서 못 찾던 것), 저장 대기 중
  탭을 닫으면 바로 저장 + 떠날지 묻기(`beforeunload`). 확인: `tsc -b` · oxlint 32(기존) · `npm run build` · 하위 작업자의 임시 하네스(탭·배지·채팅 폭·
  진행 목록·접힌 아이콘·Result 트리·폭 조절·PiP). **로그인한 실제 화면에서는 아직 못 봄**(로컬 서버 계정 없음) — 업데이트 후 사용자 확인 필요.

### 0.9.9: 이미지 찾기 유사도 = 밝기 SSIM × 색 · 홀수 크기 영역 · 크롭 표시는 바깥 테두리 (서버 + 에이전트 업데이트)
사용자 질문 (2026-10-27, 실제 녹화 — 1절 "유사도 피드백 받기"의 답): 검색 영역 직접 지정(20×22)으로 찾았더니 크롭한 이미지가 모든 프레임에
그대로 있고 나머지 영역만 바뀌며 유사도가 기본으로 높게(72~79%, 진짜는 Cycle 8의 99.5% 하나) 나옴 — 맞나?
- 주황 상자 = 웹의 크롭 위치 표시(`.rv-crop-rect` 안쪽 2px 테두리). 크롭이 작아(화면에서 5px쯤) 테두리가 안을 다 덮어 그림이 붙어 있는 것처럼
  보였을 뿐, 에이전트는 원본 영상을 디코딩해 비교(합성 아님). 고침: 크롭·영역 테두리를 바깥에(box-shadow·outline), 영역 색 칠 없앰.
- 높던 원인: 회색조 NCC(밝기·대비 정규화, 색 버림) + 작고 무늬 없는 주황 크롭(왼쪽 위가 밝은 완만한 흐름) → 같은 방향 밝기 흐름이면 초록 화면도
  70%대. 찾은 구간이 모두 스텝 +3.0~3.4초에 시작해 찾는 범위 끝(+5초)까지 = 후방 카메라 화면이 뜬 동안 내내.
- 함께 찾은 버그: 4:2:0 영상에서 ffmpeg crop이 좌표·크기를 짝수로 내림(15×21 요청 → 14×20 출력) → 에이전트가 요청 크기로 읽어 프레임 경계가
  어긋남(크롭 위치 그대로 + 홀수 크롭이면 진짜도 40%). 고침: 영역을 짝수로 넓혀 `crop=…:exact=1`(화면이 홀수면 끝은 그대로).
- 에이전트 `VideoImageSearch.cs`: raw를 yuv420p로(Y + 반 크기 U·V). 유사도 = 밝기 SSIM(평균 밝기·대비·무늬, C1·C2 표준 — 무늬 없는 크롭은 잡음을
  무늬로 키우지 않아 옛 '한 색 템플릿' 분기 없앰) × 색 점수(창 평균 Y·U·V → 영상의 범위·행렬로 RGB → 색도 (R+16, G+16, B+16)/합 거리 d →
  1/(1+(d/0.1)⁴): 같은 색이 어두워진 것은 1, 주황↔초록·회색 0). 템플릿 밝기는 웹이 보낸 R·G·B로 영상마다 그 행렬로 다시 구함(웹 회색조는 BT.601 —
  BT.709 영상에서 주황·초록이 섞인 크롭은 밝기 관계가 달라 진짜도 93%). 색은 SSIM이 그 줄의 지금까지 최댓값보다 클 때만(정확한 가지치기),
  넓은 영역은 U·V 적분 영상. `VideoTrimmer.Probe`에 픽셀 형식·색 정보("yuv420p(tv, bt709, …)"), `VideoColor.Of`: tv/pc·yuvj,
  bt709/bt2020/bt470bg·smpte170m, 모르면 720줄 이상 BT.709, RGB 영상은 ffmpeg가 바꾼 BT.601 제한 범위.
- 계약 `ImageSearchRequest.TemplateRgb`(byte[]?, 템플릿 크기×3). 없으면(옛 웹·0.9.9 전에 저장한 예약) 회색조 SSIM만 → **예약은 다시 저장해야 색 비교**.
  옛 에이전트는 새 필드를 무시(옛 NCC). 웹: `captureTemplate` → gray·rgb·preview, `templateRgb`(100만 픽셀 넘으면 안 보냄). 서버 작업 params에는
  rgb를 안 적고 다시 열면 미리보기 PNG(손실 없음)에서 되살림(`rgbFromPreview`).
- 확인(하네스 scratchpad searchtest: 에이전트 소스를 링크해 합성 640×360 20초 — 초록 빛 배경, 6~8초 회색(주황과 같은 밝기) · 12~14초 주황 ·
  16~18초 20% 어두운 주황): 옛 코드 = 직접 지정 20×24 배경 97% · 회색 97% · 주황 98%, 15×21은 프레임 533개로 어긋나 주황 40%, 화면 전체 배경 98%.
  새 코드 = 다섯 영역 방식 모두 배경·회색 1%, 주황 100%, 어두운 주황 95%(15×21은 아래 한 줄이 배경이라 80%). 색 없는 요청 = 배경 86~89% · 회색 99%.
  1080p 20초: 화면 전체 1.59 → 1.98초, 600×400 1.07 → 0.92, 크롭 위치 1.01 → 0.92. d3d11va 출력 = CPU 출력(바이트 같음), 홀수 exact 출력 크기 =
  에이전트 계산. 미리보기 PNG 되살리기 차이 0, 테두리 비교(Playwright). `tsc -b` · oxlint 32 · `npm run build` · 솔루션 빌드(경고는 기존 것).
- 남은 일: 실제 녹화에서 진짜가 90%를 넘는지, 노출이 크게 바뀌는 영상(20% 어두워지면 약 95%)에서 기준 조정 필요한지 사용자 피드백.

### 0.9.10: PC 목록 폴더 권한 — Setting › 인원 권한 › PC 폴더 (서버(웹) 업데이트)
사용자 요청 (2026-10-28): PC 목록 폴더별로 사용자에게 권한을 줄 수 있게. 기본은 모든 폴더, 관리자가 인원 권한에서 조절.
- 저장: `org.json`의 `ProjectFolderPerms` (projectId → userId → 볼 수 있는 폴더 id, `"ungrouped"` = 미분류 PC). 없는 사용자 = 모든 폴더(새 폴더 포함).
  `OrgStore.SetUserFolders`(null = 모두, 빈 목록 = 볼 PC 없음, 조정하면 '권한 설정됨'), `FoldersOf`(관리자는 늘 모두), 프로젝트를 지우면 함께 지움.
  API `PUT /api/auth/folder-perms/{userId}` `{ folders: string[] | null }` (관리자 세션). 로그인·`/auth/me` 결과에 `folders`.
- 새 폴더: `PUT /api/pc-groups`가 저장 전후 폴더를 비교 → `OrgStore.InheritFolders`: 폴더 권한이 걸린 사람이 상위 폴더를 볼 수 있으면 새 하위
  폴더도(여러 단계 한 번에), 만든 사람(`X-User-Id`)은 자기가 만든 폴더(맨 위 포함)를 늘 봄 → 바뀌면 OrgChanged 방송. 폴더 권한이 하나도 없으면
  org.json을 쓰지 않음.
- 판정(폴더마다 따로): 고른 폴더의 PC만 보임. 고르지 않았지만 아래에 고른 폴더가 있는 상위 폴더는 이름만(흐리게, PC·관리 동작 없음).
  웹 `perms.ts` `folderAccess(groups, allowed)` → `FolderAccessContext`(App이 org 방송·pcGroups로 계산, org를 받기 전에는 로그인 결과의 folders).
  적용: PC 트리(PC Manager·Result — 폴더 줄 `shows`, 미분류 줄은 '미분류'를 고른 때만), PC 목록(`showsAgent` — FileExplorer·Remote 구역·Result·
  원격조작 탭 빠른 전환·State의 PC·작업·원격 표시), 열려 있던 파일 창은 숨김(저장한 창 목록은 그대로 — 권한이 돌아오면 다시 보임),
  원격조작 탭(?remote=)은 "이 PC가 들어 있는 폴더를 볼 권한이 없습니다", 파일 즐겨찾기는 열 수 없음 표시.
- 폴더 권한이 걸린 사람의 관리 동작: 볼 수 있는 폴더에만 하위 폴더·이름 바꾸기·PC 넣기·프로젝트 배정, 지우기는 아래 폴더를 모두 볼 수 있을 때만.
- 설정 화면: 인원 권한 표 끝 'PC 폴더' 열(전체 / N개 폴더[+ 미분류] / 미분류만 / 없음, 마우스를 올리면 폴더 경로) → `FolderPermDialog`
  (모든 폴더 ↔ 고른 폴더만, 이 프로젝트에서 보이는 폴더 트리 체크 — 폴더를 켜고 끄면 아래 폴더도 함께, 아래만 켜진 폴더는 일부 표시, 폴더별 PC 수,
  [저장]). 트리·표 글은 `folderPermTree.ts`. 진행상황 PiP가 저장 버튼을 가려 `data-no-pip`.
- 기능 권한처럼 화면에서만 숨긴다 (서버 API는 검사하지 않음). State 화면은 예전처럼 프로젝트 배정으로는 거르지 않음(폴더 권한만 적용).
- 확인: OrgStore 하네스(scratchpad orgtest — 값 정리·상속·만든 사람·관리자 거부·빈 목록·다시 읽기·옛 org.json·프로젝트 삭제). 시험 서버 사본
  (포트 5089, 사용자 서버 5063과 다른 데이터) + Playwright(`/api/auth/me`·`/api/agents`만 가짜): 제한 사용자 트리·Remote·State·Result, 하위·맨 위
  새 폴더 상속, 권한 회수 시 열린 창 숨김(실시간 OrgChanged), 원격 탭 차단, 관리자 표·창·PUT 본문, English·390px. `tsc -b` · oxlint 32 ·
  `npm run build` · 솔루션 빌드.
- 남은 일: 실제 관리자 로그인으로 저장해 보기 (PUT 엔드포인트는 하네스의 `SetUserFolders`와 세션 없을 때 403만 확인).

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
