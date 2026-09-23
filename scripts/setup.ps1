param(
  [ValidateSet('start', 'doctor', 'stop', 'status', 'logs')]
  [string]$Action = 'start',
  [switch]$InstallDocker,
  [switch]$Light,
  [switch]$NoOpen,
  [ValidateSet('ollama', 'google', 'kimi', 'cursor', 'bedrock')]
  [string]$Provider
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $ProjectRoot
$EnvFile = Join-Path $ProjectRoot '.env.docker'
$EnvExample = Join-Path $ProjectRoot '.env.docker.example'
$ComposeFiles = @('--env-file', $EnvFile, '-f', 'docker-compose.yml', '-f', 'docker-compose.local.yml')
$script:DockerPath = $null

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Resolve-DockerPath {
  $command = Get-Command docker.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'),
    'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $env:PATH = "$(Split-Path -Parent $candidate);$env:PATH"
      return $candidate
    }
  }
  return $null
}

function Install-DockerDesktop {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw 'Docker Desktop is missing and winget is unavailable. Install it from https://docs.docker.com/desktop/setup/install/windows-install/ and rerun this script.'
  }
  Write-Step 'Installing Docker Desktop with winget'
  & $winget.Source install --exact --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop installation failed.' }
}

function Confirm-DockerInstall {
  if ($InstallDocker) { return $true }
  $answer = Read-Host 'Docker Desktop is not installed. Install it now with winget? This requires accepting Docker Desktop terms [y/N]'
  return $answer -match '^(y|yes|s|si|sí)$'
}

function Test-DockerDaemon {
  if (-not $script:DockerPath) { return $false }
  try {
    & $script:DockerPath info *> $null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

function Start-DockerDesktop {
  if (Test-DockerDaemon) { return }
  Write-Step 'Starting Docker Desktop'
  try { & $script:DockerPath desktop start --timeout 120 *> $null } catch { }
  if (-not (Test-DockerDaemon)) {
    $desktopCandidates = @(
      (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
      'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    )
    $desktop = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($desktop) { Start-Process -FilePath $desktop }
  }

  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    if (Test-DockerDaemon) { return }
    Start-Sleep -Seconds 3
  }
  throw 'Docker Desktop did not become ready within three minutes. Complete any first-run prompts and rerun the script.'
}

function Invoke-Compose([string[]]$Arguments) {
  & $script:DockerPath compose @ComposeFiles @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed: $($Arguments -join ' ')" }
}

function Initialize-Environment {
  if (-not (Test-Path -LiteralPath $EnvFile)) {
    Copy-Item -LiteralPath $EnvExample -Destination $EnvFile
    Write-Host 'Created .env.docker from the reviewed example.'
  }
}

function Get-EnvValue([string]$Name) {
  $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
  if (-not $line) { return '' }
  return ($line -replace "^$([regex]::Escape($Name))=", '').Trim().Trim("'", '"')
}

function Set-EnvValue([string]$Name, [string]$Value, [bool]$Secret = $false) {
  if ($Value -match "[`r`n]") { throw "$Name must be a single line." }
  $encoded = if ($Secret) { "'$($Value.Replace("'", "\'"))'" } else { $Value }
  $lines = @(Get-Content -LiteralPath $EnvFile | Where-Object { $_ -notmatch "^$([regex]::Escape($Name))=" })
  $lines += "$Name=$encoded"
  [IO.File]::WriteAllLines($EnvFile, [string[]]$lines, [Text.UTF8Encoding]::new($false))
}

function Read-Secret([string]$Name) {
  if ([Console]::IsInputRedirected) { throw "$Name is missing. Set it in .env.docker before running non-interactively." }
  $secure = Read-Host "$Name (input hidden)" -AsSecureString
  $value = [pscredential]::new('agentictm', $secure).GetNetworkCredential().Password
  if (-not $value) { throw "$Name is required for the selected provider." }
  Set-EnvValue $Name $value $true
}

function Select-SetupProvider {
  $selected = $Provider
  if (-not $selected -and (Get-EnvValue 'SETUP_PROVIDER_SELECTED') -eq 'true') {
    $selected = Get-EnvValue 'LLM_PROVIDER'
  }
  if (-not $selected) {
    if ([Console]::IsInputRedirected) { throw 'Choose an inference provider with -Provider ollama|google|kimi|cursor|bedrock before a non-interactive start.' }
    Write-Host "`nChoose how Argus will run inference:"
    Write-Host '  1. API key (no Ollama model downloads)'
    Write-Host '  2. Local Ollama models (about 12.5 GB standard, less with -Light)'
    $mode = Read-Host 'Choice [1/2]'
    if ($mode -eq '2') { $selected = 'ollama' }
    elseif ($mode -eq '1') {
      Write-Host '  1. Google Gemini  2. Kimi  3. Cursor  4. AWS Bedrock'
      $choice = Read-Host 'API provider [1-4]'
      $selected = switch ($choice) { '1' { 'google' } '2' { 'kimi' } '3' { 'cursor' } '4' { 'bedrock' } default { throw 'Choose an API provider from 1 to 4.' } }
    } else { throw 'Choose 1 for an API provider or 2 for local models.' }
  }
  if ($selected -notin @('ollama', 'google', 'kimi', 'cursor', 'bedrock')) { throw "Unsupported provider in .env.docker: $selected" }
  Set-EnvValue 'LLM_PROVIDER' $selected
  Set-EnvValue 'RAG_DEFAULT_ENABLED' $(if ($selected -eq 'ollama') { 'true' } else { 'false' })
  Set-EnvValue 'SETUP_PROVIDER_SELECTED' 'true'
  $env:LLM_PROVIDER = $selected
  $env:RAG_DEFAULT_ENABLED = if ($selected -eq 'ollama') { 'true' } else { 'false' }

  $required = switch ($selected) {
    'google' { @('GOOGLE_API_KEY') }
    'kimi' { @('KIMI_API_KEY') }
    'cursor' { @('CURSOR_API_KEY') }
    'bedrock' { @('BEDROCK_AWS_ACCESS_KEY_ID', 'BEDROCK_AWS_SECRET_ACCESS_KEY') }
    default { @() }
  }
  foreach ($name in $required) {
    if ((Get-EnvValue $name) -or [Environment]::GetEnvironmentVariable($name)) { continue }
    Read-Secret $name
  }
  if ($selected -eq 'ollama' -and $Light) {
    $env:OLLAMA_QUICK_MODEL = 'qwen3.5:4b'
    $env:OLLAMA_DEEP_MODEL = 'qwen3.5:4b'
    $env:EMBEDDING_MODEL = 'qwen3-embedding:0.6b'
    $env:OLLAMA_QUICK_NUM_CTX = '8192'
    $env:OLLAMA_DEEP_NUM_CTX = '8192'
    Write-Host 'Using the light profile: one 4B analysis model and the 0.6B embedding model.' -ForegroundColor Yellow
  }
  if ($selected -ne 'ollama' -and $Light) { Write-Warning '-Light applies only to Ollama models; no models will be downloaded.' }
  Write-Host "Inference provider: $selected"
  return $selected
}

function Show-Doctor {
  Write-Host "Argus Docker doctor"
  Write-Host "Repository: $ProjectRoot"
  Write-Host "Architecture: $([Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
  try {
    $memoryGb = [math]::Round((Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory / 1GB, 1)
    Write-Host "System memory: $memoryGb GB"
    if ($memoryGb -lt 16) { Write-Warning 'Less than 16 GB RAM detected. Use -Light.' }
  } catch { Write-Host 'System memory: unavailable to this shell' }
  try {
    $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($ProjectRoot).TrimEnd(':', '\'))
    $freeGb = [math]::Round($drive.Free / 1GB, 1)
    Write-Host "Free disk: $freeGb GB"
    if ($freeGb -lt 30) { Write-Warning 'The standard profile may need more than 30 GB free including images, build layers and models. Use -Light.' }
  } catch { Write-Host 'Free disk: unavailable to this shell' }

  if (-not $script:DockerPath) {
    Write-Host 'Docker CLI: missing' -ForegroundColor Red
    return $false
  }
  Write-Host "Docker CLI: $script:DockerPath"
  try {
    $dockerVersion = (& $script:DockerPath --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw $dockerVersion }
    $composeVersion = (& $script:DockerPath compose version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw $composeVersion }
    Write-Host $dockerVersion
    Write-Host $composeVersion
  } catch {
    Write-Host "Docker CLI: unavailable ($($_.Exception.Message))" -ForegroundColor Red
    return $false
  }
  if (-not (Test-DockerDaemon)) {
    Write-Host 'Docker daemon: not running' -ForegroundColor Red
    return $false
  }
  $osType = (& $script:DockerPath info --format '{{.OSType}}').Trim()
  Write-Host "Docker daemon: ready ($osType containers)"
  if ($osType -ne 'linux') { throw 'Argus requires Docker Desktop Linux containers. Switch the Docker engine and rerun.' }
  return $true
}

function Get-AppPort {
  if ($env:APP_PORT) { return [int]$env:APP_PORT }
  $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match '^APP_PORT=' } | Select-Object -First 1
  if ($line) { return [int]($line -replace '^APP_PORT=', '') }
  return 8080
}

function Wait-ForApp([int]$Port) {
  $url = "http://127.0.0.1:$Port/api/health"
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { return }
    } catch { }
    Start-Sleep -Seconds 3
  }
  Invoke-Compose @('ps')
  throw "Argus did not become ready at $url. Run .\scripts\setup.ps1 logs to inspect the stack."
}

$script:DockerPath = Resolve-DockerPath
Initialize-Environment
$selectedProvider = if ($Action -eq 'start') { Select-SetupProvider } else { $null }

if ($Action -eq 'doctor') {
  if (-not (Show-Doctor)) { exit 1 }
  Invoke-Compose @('config', '--quiet')
  Write-Host 'Compose configuration: valid' -ForegroundColor Green
  exit 0
}

if (-not $script:DockerPath) {
  if (-not (Confirm-DockerInstall)) { throw 'Docker Desktop is required. Installation was not authorized.' }
  Install-DockerDesktop
  $script:DockerPath = Resolve-DockerPath
  if (-not $script:DockerPath) { throw 'Docker was installed but its CLI is not available yet. Start Docker Desktop, open a new PowerShell window and rerun this script.' }
}

Start-DockerDesktop
if (-not (Show-Doctor)) { throw 'Docker Desktop is not ready.' }
Invoke-Compose @('config', '--quiet')

switch ($Action) {
  'stop' {
    Write-Step 'Stopping Argus without deleting persistent data'
    Invoke-Compose @('down')
    exit 0
  }
  'status' {
    Invoke-Compose @('ps')
    exit 0
  }
  'logs' {
    Invoke-Compose @('logs', '--follow', '--tail', '200')
    exit 0
  }
}

if ($selectedProvider -eq 'ollama') {
  Write-Step 'Starting Ollama and Chroma'
  Invoke-Compose @('up', '-d', 'ollama', 'chromadb')
  Write-Step 'Preparing the configured Ollama models (the first run downloads several GB)'
  Invoke-Compose @('run', '--rm', 'ollama-models')
} else {
  Write-Step 'Starting Chroma without downloading Ollama models'
  Invoke-Compose @('stop', 'ollama')
  Invoke-Compose @('up', '-d', 'chromadb')
}

Write-Step 'Building and starting Argus and pipeline-worker'
Invoke-Compose @('up', '--build', '-d', 'app', 'worker')

$port = Get-AppPort
Wait-ForApp -Port $port
Invoke-Compose @('ps')
$appUrl = "http://127.0.0.1:$port"
Write-Host "`nArgus is ready: $appUrl" -ForegroundColor Green
Write-Host 'Persistent Docker volumes keep projects, knowledge, vectors and models across restarts.'
if ($selectedProvider -ne 'ollama') { Write-Host 'Cloud inference is selected. Knowledge retrieval is off by default; local Ollama is needed if you enable it later.' }
Write-Host 'Stop safely with: .\scripts\setup.ps1 stop'
if (-not $NoOpen) { Start-Process $appUrl }
