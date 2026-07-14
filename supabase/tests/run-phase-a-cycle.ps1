[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$databaseUrlVariable = "PHASE_A_TEST_DATABASE_URL"
$databaseUrl = [Environment]::GetEnvironmentVariable($databaseUrlVariable, "Process")

if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
  throw "Set $databaseUrlVariable to a disposable local PostgreSQL fixture restored from the reviewed Frankfurt baseline."
}

try {
  $parsedDatabaseUrl = [Uri]$databaseUrl
} catch {
  throw "$databaseUrlVariable is not a valid PostgreSQL URI."
}

$loopbackHosts = @("localhost", "127.0.0.1", "::1")
if ($parsedDatabaseUrl.Scheme -notin @("postgres", "postgresql") -or
    $parsedDatabaseUrl.Host -notin $loopbackHosts) {
  throw "Refusing Phase A cycle: the fixture URL must target a loopback PostgreSQL host."
}

if ($databaseUrl -match '(?i)supabase\.co|rmslvptafkxywhpzpuxt|setynlgmdzaceegrlgwg') {
  throw "Refusing Phase A cycle: production and rollback Supabase projects are never test fixtures."
}

$psql = Get-Command "psql" -ErrorAction SilentlyContinue
if (-not $psql) {
  throw "psql was not found on PATH."
}

$supabaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$forwardMigration = Join-Path $supabaseRoot "migrations\20260715000000_phase_a_capability_containment.sql"
$rollbackMigration = Join-Path $supabaseRoot "rollbacks\20260715000000_phase_a_capability_containment.rollback.sql"
$catalogTest = Join-Path $PSScriptRoot "phase_a_capability_containment.sql"
$rpcMatrixTest = Join-Path $PSScriptRoot "phase_a_capability_containment_rpc_matrix.sql"

foreach ($file in @($forwardMigration, $rollbackMigration, $catalogTest, $rpcMatrixTest)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "Missing Phase A cycle artifact: $file"
  }
}

function Invoke-PsqlFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,

    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  Write-Host "[$Label] $Path"
  # This hosted Windows shell ignores PGDATABASE for native psql. Pass the
  # already loopback/ref-validated fixture URL directly; PowerShell does not
  # echo native arguments.
  $errorFile = [IO.Path]::GetTempFileName()
  try {
    $savedErrorActionPreference = $ErrorActionPreference
    $nativePreferenceExists = $null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue)
    if ($nativePreferenceExists) {
      $savedNativePreference = $PSNativeCommandUseErrorActionPreference
    }

    try {
      $ErrorActionPreference = "Continue"
      if ($nativePreferenceExists) {
        $PSNativeCommandUseErrorActionPreference = $false
      }
      & $psql.Source --dbname=$databaseUrl -X --set=ON_ERROR_STOP=1 --file=$Path 2> $errorFile
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $savedErrorActionPreference
      if ($nativePreferenceExists) {
        $PSNativeCommandUseErrorActionPreference = $savedNativePreference
      }
    }

    if ($exitCode -ne 0) {
      $safeError = Get-Content -LiteralPath $errorFile -Raw -ErrorAction SilentlyContinue
      if ([string]::IsNullOrWhiteSpace($safeError)) {
        $safeError = "No PostgreSQL diagnostic was returned."
      }
      $safeError = [regex]::Replace(
        $safeError,
        '(?i)postgres(?:ql)?://\S+',
        '[REDACTED_DATABASE_URL]'
      )
      throw "Phase A cycle failed at $Label`: $safeError"
    }
  } finally {
    if (Test-Path -LiteralPath $errorFile) {
      Remove-Item -LiteralPath $errorFile -Force
    }
  }
}

$oldConnectTimeout = $env:PGCONNECT_TIMEOUT

try {
  $env:PGCONNECT_TIMEOUT = "10"

  Invoke-PsqlFile -Label "forward-1" -Path $forwardMigration
  Invoke-PsqlFile -Label "catalog-1" -Path $catalogTest
  Invoke-PsqlFile -Label "rpc-negative-positive-1" -Path $rpcMatrixTest

  Invoke-PsqlFile -Label "rollback" -Path $rollbackMigration

  Invoke-PsqlFile -Label "forward-2" -Path $forwardMigration
  Invoke-PsqlFile -Label "catalog-2" -Path $catalogTest
  Invoke-PsqlFile -Label "rpc-negative-positive-2" -Path $rpcMatrixTest

  [pscustomobject]@{
    Result = "passed"
    Sequence = "forward -> catalog/RPC matrix -> rollback -> forward -> catalog/RPC matrix"
    FinalFixtureState = "Phase A forward migration applied"
    Host = $parsedDatabaseUrl.Host
  }
} finally {
  if ($null -eq $oldConnectTimeout) {
    Remove-Item Env:PGCONNECT_TIMEOUT -ErrorAction SilentlyContinue
  } else {
    $env:PGCONNECT_TIMEOUT = $oldConnectTimeout
  }
  $databaseUrl = $null
}
