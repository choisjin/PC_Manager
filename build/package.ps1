#Requires -Version 7.3
<#
.SYNOPSIS
  배포 패키지를 만듭니다.

.DESCRIPTION
  artifacts 폴더에 다음을 만듭니다.
  - PcManager-Server-<버전>.zip     : 서버 + 대시보드 + 에이전트 설치 파일 + 설치 스크립트
  - PcManager-Agent-Setup-<버전>.exe : 테스트 PC용 더블클릭 설치 파일 (단독 배포용)

  에이전트는 단일 실행 파일 하나로 설치/서비스/런처를 모두 담당합니다.
  필요: .NET 10 SDK, Node.js 20 이상. 결과물은 .NET 런타임 없이 실행됩니다.

.EXAMPLE
  pwsh build/package.ps1
  pwsh build/package.ps1 -Version 0.3.0
#>
param(
    [string] $Version,
    [string] $Runtime = 'win-x64',
    [string] $OutputDir
)

$ErrorActionPreference = 'Stop'
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

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
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

Write-Step '에이전트 설치 파일 게시 (단일 exe: 설치 + 서비스 + 런처)'
$agentPublishDir = Join-Path $staging 'agent-publish'
dotnet publish (Join-Path $root 'src/PcManager.Agent') @publishArgs `
    -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $agentPublishDir
$setupExe = Join-Path $OutputDir "PcManager-Agent-Setup-$Version.exe"
Copy-Item -Path (Join-Path $agentPublishDir 'PcManager.Agent.exe') -Destination $setupExe -Force

Write-Step '서버 게시'
$serverPackageDir = Join-Path $staging 'server-package'
$serverDir = Join-Path $serverPackageDir 'server'
dotnet publish (Join-Path $root 'src/PcManager.Server') @publishArgs -o $serverDir

# 대시보드 정적 파일
Copy-Item -Path (Join-Path $root 'web/dist') -Destination (Join-Path $serverDir 'wwwroot') -Recurse

# 대시보드 'PC 추가'에서 내려받는 설치 파일
$serverAgentDir = New-Item -ItemType Directory -Path (Join-Path $serverDir 'agent') -Force
Copy-Item -Path $setupExe -Destination (Join-Path $serverAgentDir 'PcManager-Agent-Setup.exe')

Copy-Item -Path (Join-Path $root 'installer/server/*') -Destination $serverPackageDir

$serverZip = Join-Path $OutputDir "PcManager-Server-$Version.zip"
if (Test-Path $serverZip) { Remove-Item $serverZip -Force }
Compress-Archive -Path (Join-Path $serverPackageDir '*') -DestinationPath $serverZip

Remove-Item $staging -Recurse -Force

Write-Step '완료'
Get-Item $serverZip, $setupExe |
    Format-Table Name, @{ Name = 'MB'; Expression = { [math]::Round($_.Length / 1MB, 1) } } -AutoSize
