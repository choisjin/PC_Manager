<#
.SYNOPSIS
  PC Manager 에이전트를 설치(또는 업그레이드)하고 Windows 서비스로 등록합니다.

.DESCRIPTION
  가장 쉬운 방법은 대시보드의 '에이전트 추가'에서 복사한 한 줄 명령을
  테스트 PC의 관리자 PowerShell에서 실행하는 것입니다. (서버에서 패키지를 내려받아 설치)

  에이전트 패키지(zip)의 압축을 풀었다면 그 폴더에서 직접 실행할 수도 있습니다.

.EXAMPLE
  .\install-agent.ps1 -ServerUrl http://192.168.0.10:5063 -Token <서버 토큰> -Tags gui-test,site:seoul
#>
param(
    [Parameter(Mandatory = $true)] [string] $ServerUrl,
    [Parameter(Mandatory = $true)] [string] $Token,
    [string[]] $Tags = @(),
    [string] $InstallDir = (Join-Path $env:ProgramFiles 'PcManager\Agent'),
    # 에이전트 zip 경로. 비우면 스크립트 옆의 파일을 쓰고, 없으면 서버에서 내려받는다
    [string] $PackagePath
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'PcManagerAgent'
$ExeName = 'PcManager.Agent.Service.exe'
$ConfigDir = Join-Path $env:ProgramData 'PcManager\Agent'
$ConfigPath = Join-Path $ConfigDir 'agent.json'
$ServerUrl = $ServerUrl.TrimEnd('/')

function Write-Step([string] $Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '관리자 권한 PowerShell에서 실행하세요. (시작 메뉴에서 PowerShell 우클릭 > 관리자 권한으로 실행)'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# Windows PowerShell 5.1은 진행률 표시 때문에 다운로드가 매우 느려진다
$ProgressPreference = 'SilentlyContinue'

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ('pcmanager-agent-' + [Guid]::NewGuid().ToString('N'))
try {
    Write-Step "서버 연결 확인: $ServerUrl"
    try {
        $null = Invoke-WebRequest -Uri "$ServerUrl/api/install/info" -UseBasicParsing -TimeoutSec 10
    }
    catch {
        Write-Warning "서버에 연결할 수 없습니다. 설치는 계속하며, 에이전트가 연결될 때까지 자동으로 재시도합니다. ($($_.Exception.Message))"
    }

    # 설치할 파일 위치: 압축을 푼 패키지 폴더 > 지정한 zip > 서버에서 다운로드
    if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot $ExeName)) -and -not $PackagePath) {
        $sourceDir = $PSScriptRoot
    }
    else {
        New-Item -ItemType Directory -Path $tempDir | Out-Null
        if (-not $PackagePath) {
            $PackagePath = Join-Path $tempDir 'PcManager-Agent.zip'
            Write-Step '에이전트 패키지 다운로드'
            Invoke-WebRequest -Uri "$ServerUrl/api/install/agent.zip?token=$([Uri]::EscapeDataString($Token))" -OutFile $PackagePath -UseBasicParsing
        }
        $extractDir = Join-Path $tempDir 'package'
        Expand-Archive -Path $PackagePath -DestinationPath $extractDir -Force
        $exe = Get-ChildItem -Path $extractDir -Filter $ExeName -Recurse | Select-Object -First 1
        if (-not $exe) {
            throw "패키지에 $ExeName 파일이 없습니다: $PackagePath"
        }
        $sourceDir = $exe.DirectoryName
    }
    # 인터넷에서 받은 zip을 풀면 파일마다 '차단' 표시가 붙어 있을 수 있다
    Get-ChildItem -Path $sourceDir -Recurse -File | Unblock-File

    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing -and $existing.Status -ne 'Stopped') {
        Write-Step '기존 에이전트 서비스 중지 (업그레이드)'
        Stop-Service -Name $ServiceName -Force
        $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }

    Write-Step "파일 복사: $InstallDir"
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    # 서비스가 막 멈춘 직후에는 실행 파일이 잠겨 있을 수 있어 잠시 재시도한다
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            Copy-Item -Path (Join-Path $sourceDir '*') -Destination $InstallDir -Recurse -Force
            break
        }
        catch {
            if ($attempt -eq 10) { throw }
            Start-Sleep -Seconds 2
        }
    }

    Write-Step "설정 저장: $ConfigPath"
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    $config = @{
        Agent = @{
            ServerUrl = $ServerUrl
            Token     = $Token
            Tags      = @($Tags | Where-Object { $_ })
        }
    }
    $config | ConvertTo-Json -Depth 5 | Set-Content -Path $ConfigPath -Encoding UTF8
    # 토큰이 들어 있으므로 Administrators와 SYSTEM만 읽을 수 있게 한다
    & icacls.exe $ConfigPath /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null

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
        New-Service -Name $ServiceName -BinaryPathName $binaryPath -DisplayName 'PC Manager Agent' `
            -Description 'PC Manager 테스트 PC 에이전트 - 원격 명령, Job, 파일 전송을 처리합니다.' `
            -StartupType Automatic | Out-Null
    }
    # 부팅 직후 네트워크가 준비된 뒤 시작하고, 비정상 종료되면 5초 후 다시 시작한다
    & sc.exe config $ServiceName start= delayed-auto | Out-Null
    & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null

    Write-Step '서비스 시작'
    Start-Service -Name $ServiceName
    (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))

    Write-Step '서버 등록 확인 (최대 30초)'
    $registered = $false
    for ($i = 0; $i -lt 15 -and -not $registered; $i++) {
        Start-Sleep -Seconds 2
        try {
            $agents = Invoke-RestMethod -Uri "$ServerUrl/api/agents" -UseBasicParsing -TimeoutSec 5
            $registered = @($agents | Where-Object { $_.machineName -eq $env:COMPUTERNAME -and $_.online }).Count -gt 0
        }
        catch {
            # 서버 응답 대기
        }
    }

    Write-Host ''
    if ($registered) {
        Write-Host "설치 완료: 대시보드($ServerUrl)에서 $env:COMPUTERNAME PC가 온라인으로 표시됩니다." -ForegroundColor Green
    }
    else {
        Write-Warning "서비스는 실행 중이지만 서버 등록을 확인하지 못했습니다. 서버 주소, 토큰, 방화벽을 확인하세요."
        Write-Warning "오류 로그: 이벤트 뷰어 > Windows 로그 > 응용 프로그램 (원본: PcManager.Agent.Service)"
    }
    Write-Host "설치 위치: $InstallDir"
    Write-Host "설정 파일: $ConfigPath (서버 주소/토큰/태그 변경 후 'Restart-Service $ServiceName')"
}
finally {
    if (Test-Path $tempDir) {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
