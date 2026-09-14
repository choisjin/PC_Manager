<#
.SYNOPSIS
  PC Manager 서버 서비스를 제거합니다. (관리자 PowerShell)

.PARAMETER RemoveData
  설정(에이전트 토큰), DB, 실행 로그, 결과 파일까지 삭제합니다. 되돌릴 수 없습니다.
#>
param(
    [switch] $RemoveData,
    [string] $InstallDir = (Join-Path $env:ProgramFiles 'PcManager\Server')
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'PcManagerServer'
$DataDir = Join-Path $env:ProgramData 'PcManager\Server'
$FirewallRuleName = 'PC Manager Server'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '관리자 권한 PowerShell에서 실행하세요.'
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host '==> 서비스 중지 및 삭제' -ForegroundColor Cyan
    if ($service.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    & sc.exe delete $ServiceName | Out-Null
}
else {
    Write-Host '등록된 서버 서비스가 없습니다.'
}

Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

if (Test-Path $InstallDir) {
    Write-Host "==> 프로그램 파일 삭제: $InstallDir" -ForegroundColor Cyan
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            Remove-Item -Path $InstallDir -Recurse -Force
            break
        }
        catch {
            if ($attempt -eq 10) { throw }
            Start-Sleep -Seconds 2
        }
    }
}

if ($RemoveData) {
    if (Test-Path $DataDir) {
        Write-Host "==> 데이터 삭제: $DataDir" -ForegroundColor Cyan
        Remove-Item -Path $DataDir -Recurse -Force
    }
}
else {
    Write-Host "설정과 데이터는 남겨두었습니다: $DataDir (다시 설치하면 그대로 이어서 사용, 함께 지우려면 -RemoveData)"
}

Write-Host '서버 제거 완료' -ForegroundColor Green
