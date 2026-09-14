<#
.SYNOPSIS
  PC Manager 에이전트 서비스를 제거합니다. (관리자 PowerShell)

.PARAMETER RemoveData
  설정(서버 주소/토큰), PC 고유 ID, 결과/작업 폴더까지 삭제합니다.
  PC 고유 ID를 지우면 다시 설치했을 때 대시보드에 새 PC로 등록됩니다.
#>
param(
    [switch] $RemoveData,
    [string] $InstallDir = (Join-Path $env:ProgramFiles 'PcManager\Agent')
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'PcManagerAgent'
$DataDir = Join-Path $env:ProgramData 'PcManager\Agent'

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
    Write-Host '등록된 에이전트 서비스가 없습니다.'
}

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
    Write-Host "설정과 결과 파일은 남겨두었습니다: $DataDir (함께 지우려면 -RemoveData)"
}

Write-Host '에이전트 제거 완료' -ForegroundColor Green
