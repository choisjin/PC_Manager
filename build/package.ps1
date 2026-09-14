#Requires -Version 7.3
<#
.SYNOPSIS
  배포 패키지를 만듭니다.

.DESCRIPTION
  artifacts 폴더에 두 개의 zip을 만듭니다.
  - PcManager-Server-<버전>.zip : 서버 + 대시보드 + 에이전트 원격 설치 파일 + 설치 스크립트
  - PcManager-Agent-<버전>.zip  : 에이전트 단독 설치용 (서버에 접속할 수 없는 PC에 수동 설치)

  필요: .NET 10 SDK, Node.js 20 이상. 결과물은 .NET 런타임 없이 실행되는 self-contained 빌드입니다.

.EXAMPLE
  pwsh build/package.ps1
  pwsh build/package.ps1 -Version 0.3.0
#>
param(
    # 비우면 Directory.Build.props의 Version
    [string] $Version,
    [string] $Runtime = 'win-x64',
    [string] $OutputDir
)

$ErrorActionPreference = 'Stop'
# 외부 명령(dotnet, npm)이 실패하면 즉시 중단
$PSNativeCommandUseErrorActionPreference = $true

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $root 'artifacts' }
if (-not $Version) {
    $Version = ([xml](Get-Content (Join-Path $root 'Directory.Build.props'))).Project.PropertyGroup.Version
}
$Version = $Version.TrimStart('v')

function Write-Step([string] $Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

$staging = Join-Path $OutputDir 'staging'
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$publishArgs = @(
    '-c', 'Release',
    '-r', $Runtime,
    '--self-contained', 'true',
    "-p:Version=$Version",
    '-p:DebugType=None',
    '-p:DebugSymbols=false',
    '-nologo'
)

Write-Step "대시보드 빌드 (버전 $Version)"
Push-Location (Join-Path $root 'web')
try {
    npm ci --no-audit --no-fund
    npm run build
}
finally {
    Pop-Location
}

Write-Step '에이전트 게시 (단일 실행 파일)'
$agentDir = Join-Path $staging 'agent'
dotnet publish (Join-Path $root 'src/PcManager.Agent.Service') @publishArgs `
    -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $agentDir
Copy-Item -Path (Join-Path $root 'installer/agent/*') -Destination $agentDir

$agentZip = Join-Path $OutputDir "PcManager-Agent-$Version.zip"
Compress-Archive -Path (Join-Path $agentDir '*') -DestinationPath $agentZip -Force

Write-Step '서버 게시'
$serverPackageDir = Join-Path $staging 'server-package'
$serverDir = Join-Path $serverPackageDir 'server'
dotnet publish (Join-Path $root 'src/PcManager.Server') @publishArgs -o $serverDir

# 대시보드 정적 파일
Copy-Item -Path (Join-Path $root 'web/dist') -Destination (Join-Path $serverDir 'wwwroot') -Recurse

# 대시보드 'PC 추가'의 한 줄 설치 명령이 내려받는 파일
$serverAgentDir = New-Item -ItemType Directory -Path (Join-Path $serverDir 'agent') -Force
Copy-Item -Path $agentZip -Destination (Join-Path $serverAgentDir 'PcManager-Agent.zip')
Copy-Item -Path (Join-Path $root 'installer/agent/install-agent.ps1') -Destination $serverAgentDir

Copy-Item -Path (Join-Path $root 'installer/server/*') -Destination $serverPackageDir

$serverZip = Join-Path $OutputDir "PcManager-Server-$Version.zip"
Compress-Archive -Path (Join-Path $serverPackageDir '*') -DestinationPath $serverZip -Force

Remove-Item $staging -Recurse -Force

Write-Step '완료'
Get-Item $serverZip, $agentZip |
    Format-Table Name, @{ Name = 'MB'; Expression = { [math]::Round($_.Length / 1MB, 1) } } -AutoSize
