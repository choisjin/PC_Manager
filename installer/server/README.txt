PC Manager 서버 설치 안내
==========================

요구 사항
- Windows 10/11 또는 Windows Server 2019 이상 (x64)
- .NET, Node.js 설치 필요 없음
- 테스트 PC들이 이 PC의 포트(기본 5063)에 접속할 수 있어야 함 (대시보드 HTTPS는 기본 5064)

설치
1. 이 zip의 압축을 풉니다.
2. 압축을 푼 폴더에서 관리자 권한 PowerShell을 엽니다.
   (시작 메뉴에서 PowerShell 우클릭 > 관리자 권한으로 실행 후 cd 로 폴더 이동)
3. 다음 명령을 실행합니다.

   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-server.ps1

   - 포트 변경:        -Port 8080
   - 에이전트 접속 주소: -PublicUrl http://서버이름:5063  (비우면 이 PC의 IP로 자동 설정)

4. 설치가 끝나면 표시되는 대시보드 주소를 브라우저로 엽니다.
   - HTTPS 주소(기본 https://서버IP:5064)로 열면 원격조작의 키보드 잠금(Alt+Tab·Win 키를 원격으로 전달)과
     저지연 화면 디코딩을 쓸 수 있습니다. 브라우저 정책상 HTTP에서는 이 기능이 동작하지 않습니다.
   - 인증서 신뢰는 자동입니다. 서버 PC는 서비스가 시작할 때, 에이전트가 설치된 PC는 서버에 등록될 때
     자체 서명 인증서를 "신뢰할 수 있는 루트 인증 기관"에 넣으므로 경고 없이 열립니다. (브라우저를 다시 열어야 반영)
   - 에이전트가 없는 PC에서 열 때는 대시보드 [PC 추가] 창의 "인증서 설치 도구"(.cmd)를 받아 더블클릭하고
     관리자 승인을 한 번 하면 됩니다. (또는 http://서버IP:5063/api/install/PcManager-인증서-설치.cmd)
   - 서버 IP나 이름이 바뀌면 -RenewCertificate 옵션으로 다시 설치해 인증서를 새로 만듭니다. 신뢰도 자동으로 갱신됩니다.

테스트 PC 추가
1. 대시보드 왼쪽의 [PC 추가] 버튼을 누릅니다.
2. 설치 파일(PcManager-Agent-Setup.exe)을 다운로드합니다.
3. 테스트 PC로 옮겨 더블클릭하고, 보안 경고가 뜨면 [예]를 누릅니다. (관리자 권한 요청)
4. 잠시 뒤 열리는 에이전트 창에 서버 주소를 입력하고 [연결]을 누릅니다.
   (서버 주소는 [PC 추가] 창에 표시되며 복사할 수 있습니다)
5. 대시보드에 PC가 온라인으로 표시됩니다.

업그레이드
- 새 버전 zip을 풀고 같은 설치 명령을 실행합니다. 포트, DB, 결과 파일은 유지됩니다.
- 에이전트는 테스트 PC에서 새 설치 파일을 다시 더블클릭하면 업그레이드됩니다.
  (또는 에이전트 창에서 업데이트 알림이 뜰 때 [업데이트])

설치 위치
- 프로그램: C:\Program Files\PcManager\Server
- 설정:     C:\ProgramData\PcManager\Server\server.json
- 데이터:   C:\ProgramData\PcManager\Server\data (DB, 실행 로그, 결과 파일)
- 로그:     이벤트 뷰어 > Windows 로그 > 응용 프로그램 (원본: PcManager.Server)

한 PC에서 서버 여러 개 (프로젝트별) — 서버 런처
- 릴리스의 PcManager-ServerLauncher-버전.exe를 쓰기 가능한 빈 폴더(예: D:\PcManagerServers)에 두고 실행합니다.
  서비스 설치(install-server.ps1)는 필요 없습니다.
- [일괄 업데이트]로 최신 서버를 받고, [서버 추가]로 이름·포트를 정해 서버를 만듭니다.
  (방화벽 포트는 추가할 때 관리자 승인 한 번으로 열림)
- 서버마다 데이터는 instances\이름\data, 출력은 instances\이름\server.log 에 남습니다.
- 서버들은 런처의 자식 프로세스입니다. 창을 닫으면 트레이로 내려가고, 런처를 종료하면 서버도 모두 종료됩니다.
  "Windows 로그인 시 런처 실행"을 켜 두면 로그인할 때 자동 시작이 켜진 서버들이 다시 뜹니다.
- 비정상 종료된 서버는 자동으로 다시 시작합니다 (5분 안에 3번 반복되면 멈추고 오류 표시).
- 인터넷이 막힌 곳에서는 [zip으로 업데이트…]에 PcManager-Server-버전.zip을 지정합니다.
- HTTPS: 서버마다 HTTP 포트 + HTTPS 포트(기본 HTTP+1)를 함께 엽니다. 원격조작에서 Alt+Tab·Win 키(키보드 잠금)는
  HTTPS 주소를 브라우저 새 창(최상위 창)으로 열었을 때만 됩니다. NPMS 탭 안에서는 [새 창에서 열기]를 쓰세요.
  · 인증서는 런처가 https\PcManager-Server.pfx로 만들어 모든 서버가 같이 씁니다 (PC 이름·IP가 바뀌면 새로 만듦).
  · 서버 PC: 런처가 처음에 신뢰 저장소에 넣을지 묻습니다 (관리자 승인 한 번, 나중에는 [HTTPS 인증서 신뢰(이 PC)]).
  · 에이전트 PC: 서버에 연결될 때 자동으로 신뢰합니다. 에이전트 접속 주소는 계속 HTTP 주소를 씁니다.
  · 그 밖의 PC: 대시보드 [PC 추가] 창의 "인증서 설치 도구"를 한 번 실행합니다.
  · 이미 만든 서버는 [설정]에서 "방화벽에서 이 포트 열기"를 다시 체크해 HTTPS 포트도 열어 주세요.

포터블 실행 (런처 없이 직접)
- server 폴더의 PcManager.Server.exe를 포트를 지정해 실행합니다.

   PcManager.Server.exe --port 5070 --data D:\PcManager\프로젝트A

   - --port: 대시보드·에이전트 접속 포트 (HTTP만, 방화벽은 직접 열어야 함)
   - --data: DB·로그·결과 파일 폴더 (생략하면 exe 폴더의 App_Data)
   - 설치형 설정(server.json)을 읽지 않으므로 같은 PC의 설치형 서버·다른 포터블 서버와 겹치지 않습니다.
   - 대시보드의 서버 업데이트 버튼은 동작하지 않습니다. 런처의 [일괄 업데이트]를 쓰거나 새 버전 zip의 server 폴더로 교체하세요.

제거
   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-server.ps1
   (데이터까지 삭제: -RemoveData)

주의
- 현재 버전은 대시보드 로그인이 없고, 에이전트도 서버 주소만으로 연결됩니다.
  신뢰할 수 있는 내부망에서만 사용하세요.
- 에이전트는 SYSTEM 계정 서비스로 실행되므로 GUI 자동화 테스트는 아직 지원하지 않습니다.
