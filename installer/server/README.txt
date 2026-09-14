PC Manager 서버 설치 안내
==========================

요구 사항
- Windows 10/11 또는 Windows Server 2019 이상 (x64)
- .NET, Node.js 설치 필요 없음
- 테스트 PC들이 이 PC의 포트(기본 5063)에 접속할 수 있어야 함

설치
1. 이 zip의 압축을 풉니다.
2. 압축을 푼 폴더에서 관리자 권한 PowerShell을 엽니다.
   (시작 메뉴에서 PowerShell 우클릭 > 관리자 권한으로 실행 후 cd 로 폴더 이동)
3. 다음 명령을 실행합니다.

   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-server.ps1

   - 포트 변경:        -Port 8080
   - 에이전트 접속 주소: -PublicUrl http://서버이름:5063  (비우면 이 PC의 IP로 자동 설정)

4. 설치가 끝나면 표시되는 대시보드 주소를 브라우저로 엽니다.

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

제거
   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-server.ps1
   (데이터까지 삭제: -RemoveData)

주의
- 현재 버전은 대시보드 로그인이 없고, 에이전트도 서버 주소만으로 연결됩니다.
  신뢰할 수 있는 내부망에서만 사용하세요.
- 에이전트는 SYSTEM 계정 서비스로 실행되므로 GUI 자동화 테스트는 아직 지원하지 않습니다.
