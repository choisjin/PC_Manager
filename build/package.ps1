#Requires -Version 7.3
<#
.SYNOPSIS
  배포 패키지를 만듭니다.

.DESCRIPTION
  artifacts 폴더에 다음을 만듭니다.
  - PcManager-Server-<버전>.zip     : 서버 + 대시보드 + 에이전트 설치 파일 + 설치 스크립트
  - PcManager-Agent-Setup-<버전>.exe : 테스트 PC용 더블클릭 설치 파일 (단독 배포용)
  - PcManager-ServerLauncher-<버전>.exe : 한 PC에서 서버 여러 개를 실행·업데이트하는 런처

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
    # 배포 파일 난독화 (Obfuscar, Directory.Build.targets): 설치 폴더의 dll/exe에서 코드를 읽기 어렵게
    '-p:PcmObfuscate=true',
    '-nologo'
)

Write-Step '빌드 도구 준비 (난독화 도구)'
Push-Location $root
try {
    dotnet tool restore
}
finally {
    Pop-Location
}
# 이전 Release 빌드 결과(obj/bin)를 지우고 새로 컴파일해야 난독화가 빠짐없이 적용된다
Get-ChildItem -Path (Join-Path $root 'src') -Directory | ForEach-Object {
    foreach ($sub in 'obj\Release', 'bin\Release') {
        $dir = Join-Path $_.FullName $sub
        if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    }
}

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

Write-Step '서버 런처 게시 (단일 exe: 한 PC에서 서버 여러 개 실행·일괄 업데이트)'
$launcherPublishDir = Join-Path $staging 'launcher-publish'
dotnet publish (Join-Path $root 'src/PcManager.ServerLauncher') @publishArgs `
    -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $launcherPublishDir
$launcherExe = Join-Path $OutputDir "PcManager-ServerLauncher-$Version.exe"
Copy-Item -Path (Join-Path $launcherPublishDir 'PcManager.ServerLauncher.exe') -Destination $launcherExe -Force

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
Get-Item $serverZip, $setupExe, $launcherExe |
    Format-Table Name, @{ Name = 'MB'; Expression = { [math]::Round($_.Length / 1MB, 1) } } -AutoSize
