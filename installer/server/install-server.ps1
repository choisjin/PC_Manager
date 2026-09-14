<#
.SYNOPSIS
  PC Manager 서버(대시보드 포함)를 설치(또는 업그레이드)하고 Windows 서비스로 등록합니다.

.DESCRIPTION
  서버 패키지 압축을 푼 폴더에서 관리자 PowerShell로 실행합니다.
  - 에이전트는 서버 주소만으로 연결 (인증 없음). 내부망 전용.
  - 데이터(DB, 실행 로그, 결과 파일): C:\ProgramData\PcManager\Server\data
  - 방화벽 인바운드 허용, 서비스 자동 시작

.EXAMPLE
  .\install-server.ps1
  .\install-server.ps1 -Port 8080 -PublicUrl http://pcmanager.mycompany.local:8080
  .\install-server.ps1 -AgentToken (내부망이 아니라 토큰 인증을 쓰려는 고급 사용자용)
#>
param(
    [int] $Port = 5063,
    [string] $InstallDir = (Join-Path $env:ProgramFiles 'PcManager\Server'),
    # 에이전트가 접속할 주소. 비우면 이 PC의 IP 주소로 설정
    [string] $PublicUrl,
    # 인증 토큰 (기본: 없음 = 주소만으로 연결). 지정하면 에이전트도 같은 값을 써야 함
    [string] $AgentToken = ''
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'PcManagerServer'
$ExeName = 'PcManager.Server.exe'
$ConfigDir = Join-Path $env:ProgramData 'PcManager\Server'
$ConfigPath = Join-Path $ConfigDir 'server.json'
$DataDir = Join-Path $ConfigDir 'data'
$FirewallRuleName = 'PC Manager Server'
$EventSource = 'PcManager.Server'
# 서버는 관리자 권한이 필요 없어 권한이 낮은 LocalService 계정으로 실행한다
$ServiceAccount = 'NT AUTHORITY\LocalService'
$LocalServiceSid = '*S-1-5-19'

function Write-Step([string] $Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-PrimaryIPv4 {
    $ip = Get-NetIPConfiguration |
        Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
        ForEach-Object { $_.IPv4Address.IPAddress } |
        Select-Object -First 1
    if ($ip) { return $ip }
    return $env:COMPUTERNAME
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '관리자 권한 PowerShell에서 실행하세요. (시작 메뉴에서 PowerShell 우클릭 > 관리자 권한으로 실행)'
}

$sourceDir = Join-Path $PSScriptRoot 'server'
if (-not (Test-Path (Join-Path $sourceDir $ExeName))) {
    throw "서버 파일을 찾을 수 없습니다: $sourceDir (서버 패키지 압축을 푼 폴더에서 실행하세요)"
}
# 인터넷에서 받은 zip을 풀면 파일마다 '차단' 표시가 붙어 있을 수 있다
Get-ChildItem -Path $PSScriptRoot -Recurse -File | Unblock-File

# 업그레이드: 기존 설정(토큰, 포트, 주소)을 유지한다
$existingConfig = $null
if (Test-Path $ConfigPath) {
    $existingConfig = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
}
if (-not $PSBoundParameters.ContainsKey('Port') -and $existingConfig -and "$($existingConfig.Kestrel.Endpoints.Http.Url)" -match ':(\d+)$') {
    $Port = [int]$Matches[1]
}
if (-not $PublicUrl) {
    if ($existingConfig -and $existingConfig.Server.PublicUrl) {
        $PublicUrl = $existingConfig.Server.PublicUrl
    }
    else {
        $PublicUrl = "http://$(Get-PrimaryIPv4):$Port"
    }
}
# 에이전트 인증 토큰: 기본은 없음(주소만으로 연결). -AgentToken을 주면 그 값을 쓴다.
# 업그레이드 시 이전에 토큰을 쓰던 서버라도 기본적으로 토큰을 제거한다(내부망 무인증 정책).
$token = $AgentToken

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') {
    Write-Step '기존 서버 서비스 중지 (업그레이드)'
    Stop-Service -Name $ServiceName -Force
    $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}

Write-Step "파일 복사: $InstallDir"
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
for ($attempt = 1; $attempt -le 10; $attempt++) {
    try {
        # 이전 버전 파일이 섞이지 않게 비우고 복사한다 (데이터는 ProgramData에 있어 안전)
        Get-ChildItem -Path $InstallDir -Force | Remove-Item -Recurse -Force
        Copy-Item -Path (Join-Path $sourceDir '*') -Destination $InstallDir -Recurse -Force
        break
    }
    catch {
        if ($attempt -eq 10) { throw }
        Start-Sleep -Seconds 2
    }
}

Write-Step "설정 저장: $ConfigPath"
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$config = [ordered]@{
    Kestrel = @{ Endpoints = @{ Http = @{ Url = "http://*:$Port" } } }
    Server  = [ordered]@{
        AgentToken    = $token
        DataDirectory = $DataDir
        PublicUrl     = $PublicUrl
    }
}
$config | ConvertTo-Json -Depth 6 | Set-Content -Path $ConfigPath -Encoding UTF8
# 설정(토큰)은 관리자/SYSTEM/서비스 계정만, 데이터 폴더는 서비스 계정이 쓸 수 있게
& icacls.exe $ConfigPath /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' "${LocalServiceSid}:R" | Out-Null
& icacls.exe $DataDir /grant "${LocalServiceSid}:(OI)(CI)M" | Out-Null

# LocalService 계정은 이벤트 로그 원본을 만들 수 없어 미리 등록한다
if (-not [Diagnostics.EventLog]::SourceExists($EventSource)) {
    [Diagnostics.EventLog]::CreateEventSource($EventSource, 'Application')
}

$binaryPath = '"' + (Join-Path $InstallDir $ExeName) + '"'
$service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'"
if ($service -and $service.PathName -ne $binaryPath) {
    Write-Step '설치 경로가 달라 기존 서비스 등록을 교체합니다'
    & sc.exe delete $ServiceName | Out-Null
    for ($i = 0; $i -lt 15 -and (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue); $i++) {
        Start-Sleep -Seconds 1
    }
    $service = $null
}
if (-not $service) {
    Write-Step '서비스 등록'
    New-Service -Name $ServiceName -BinaryPathName $binaryPath -DisplayName 'PC Manager Server' `
        -Description 'PC Manager 서버 - 테스트 PC 관리 대시보드와 API' -StartupType Automatic | Out-Null
    $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'"
}
$result = $service | Invoke-CimMethod -MethodName Change -Arguments @{ StartName = $ServiceAccount; StartPassword = '' }
if ($result.ReturnValue -ne 0) {
    throw "서비스 실행 계정 설정 실패 (코드 $($result.ReturnValue))"
}
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null

Write-Step "방화벽 허용: TCP $Port"
Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null

Write-Step '서비스 시작'
Start-Service -Name $ServiceName
(Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))

Write-Step '동작 확인 (최대 30초)'
$ready = $false
for ($i = 0; $i -lt 15 -and -not $ready; $i++) {
    Start-Sleep -Seconds 2
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:$Port/api/install/info" -UseBasicParsing -TimeoutSec 5
        $ready = $true
    }
    catch {
        # 시작 대기
    }
}

Write-Host ''
if ($ready) {
    Write-Host '서버 설치 완료' -ForegroundColor Green
}
else {
    Write-Warning '서비스는 시작했지만 응답을 확인하지 못했습니다. 이벤트 뷰어 > Windows 로그 > 응용 프로그램 (원본: PcManager.Server)을 확인하세요.'
}
Write-Host "대시보드 주소 : $PublicUrl"
Write-Host "에이전트 설치 : 대시보드 왼쪽 'PC 추가' > 설치 파일 다운로드 > 테스트 PC에서 더블클릭 > 서버 주소 입력"
Write-Host "설정 파일     : $ConfigPath (변경 후 'Restart-Service $ServiceName')"
Write-Host ''
Write-Warning '현재 버전은 대시보드 로그인이 없습니다. 신뢰할 수 있는 내부망에서만 사용하세요.'
