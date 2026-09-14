PC Manager 에이전트 설치 안내
=============================

가장 쉬운 방법
  대시보드 왼쪽의 [PC 추가] 버튼에서 한 줄 명령을 복사해
  테스트 PC의 관리자 권한 PowerShell에서 실행하세요. 이 zip은 필요 없습니다.

이 zip으로 직접 설치 (서버에서 내려받을 수 없는 경우)
1. 이 zip의 압축을 풉니다.
2. 압축을 푼 폴더에서 관리자 권한 PowerShell을 엽니다.
3. 서버 주소와 토큰을 넣어 실행합니다.
   토큰은 서버 PC의 C:\ProgramData\PcManager\Server\server.json 의 AgentToken 값입니다.

   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-agent.ps1 -ServerUrl http://서버IP:5063 -Token 토큰 -Tags gui-test,site:seoul

요구 사항
- Windows 10/11 또는 Windows Server 2019 이상 (x64), .NET 설치 필요 없음
- 서버 주소로 나가는 연결만 필요 (테스트 PC에 인바운드 방화벽 설정 불필요)

설치 위치
- 프로그램: C:\Program Files\PcManager\Agent
- 설정:     C:\ProgramData\PcManager\Agent\agent.json (서버 주소, 토큰, 태그)
            변경 후 관리자 PowerShell에서: Restart-Service PcManagerAgent
- 데이터:   C:\ProgramData\PcManager\Agent (PC 고유 ID, 결과 폴더, 기본 작업 폴더)
- 로그:     이벤트 뷰어 > Windows 로그 > 응용 프로그램 (원본: PcManager.Agent.Service)

제거
   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-agent.ps1
   (설정/결과/PC 고유 ID까지 삭제: -RemoveData)
