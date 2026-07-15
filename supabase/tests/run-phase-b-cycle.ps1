[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$databaseUrlVariable = "PHASE_B_TEST_DATABASE_URL"
$databaseUrl = [Environment]::GetEnvironmentVariable($databaseUrlVariable, "Process")
if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
  throw "Set $databaseUrlVariable to a disposable local PostgreSQL fixture with Phase A applied and Phase B absent."
}

try {
  $parsedDatabaseUrl = [Uri]$databaseUrl
} catch {
  throw "$databaseUrlVariable is not a valid PostgreSQL URI."
}

$loopbackHosts = @("localhost", "127.0.0.1", "::1")
if ($parsedDatabaseUrl.Scheme -notin @("postgres", "postgresql") -or
    $parsedDatabaseUrl.Host -notin $loopbackHosts) {
  throw "Refusing Phase B cycle: the fixture URL must target loopback PostgreSQL."
}
if ($databaseUrl -match '(?i)supabase\.co|rmslvptafkxywhpzpuxt|setynlgmdzaceegrlgwg') {
  throw "Refusing Phase B cycle: production and rollback Supabase projects are never test fixtures."
}

$psql = Get-Command "psql" -ErrorAction SilentlyContinue
if (-not $psql) {
  throw "psql was not found on PATH."
}

$supabaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$forwardMigration = Join-Path $supabaseRoot "migrations\20260715160000_phase_b_quote_foundation.sql"
$rollbackMigration = Join-Path $supabaseRoot "rollbacks\20260715160000_phase_b_quote_foundation.rollback.sql"
$catalogTest = Join-Path $PSScriptRoot "phase_b_quote_foundation.sql"
$rpcMatrixTest = Join-Path $PSScriptRoot "phase_b_quote_foundation_rpc_matrix.sql"

foreach ($file in @($forwardMigration, $rollbackMigration, $catalogTest, $rpcMatrixTest)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "Missing Phase B cycle artifact: $file"
  }
}

# The rollback's emptiness decision must be made while holding both the shared
# lifecycle advisory lock and ACCESS EXCLUSIVE table locks. Keep this static
# ordering assertion alongside the live forward/rollback cycle so a later edit
# cannot silently reintroduce a check-then-drop race.
$rollbackText = Get-Content -LiteralPath $rollbackMigration -Raw
$advisoryPosition = $rollbackText.IndexOf("pg_advisory_xact_lock", [StringComparison]::Ordinal)
$tableLockPosition = $rollbackText.IndexOf("IN ACCESS EXCLUSIVE MODE", [StringComparison]::Ordinal)
$rowCheckPosition = $rollbackText.IndexOf("FOREACH populated_table", [StringComparison]::Ordinal)
$firstDropPosition = $rollbackText.IndexOf("DROP TRIGGER customer_orders_quote_link_guard", [StringComparison]::Ordinal)
if ($advisoryPosition -lt 0 -or
    $tableLockPosition -le $advisoryPosition -or
    $rowCheckPosition -le $tableLockPosition -or
    $firstDropPosition -le $rowCheckPosition) {
  throw "Phase B rollback lock ordering drift: advisory lock -> table locks -> durable-row checks -> drops is required."
}

function Invoke-PsqlFile {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Path
  )

  Write-Host "[$Label] $Path"
  $errorFile = [IO.Path]::GetTempFileName()
  try {
    $savedErrorActionPreference = $ErrorActionPreference
    $nativePreferenceExists = $null -ne (
      Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
    )
    if ($nativePreferenceExists) {
      $savedNativePreference = $PSNativeCommandUseErrorActionPreference
    }
    try {
      $ErrorActionPreference = "Continue"
      if ($nativePreferenceExists) { $PSNativeCommandUseErrorActionPreference = $false }
      & $psql.Source --dbname=$databaseUrl -X --set=ON_ERROR_STOP=1 --file=$Path 2> $errorFile
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $savedErrorActionPreference
      if ($nativePreferenceExists) { $PSNativeCommandUseErrorActionPreference = $savedNativePreference }
    }
    if ($exitCode -ne 0) {
      $safeError = Get-Content -LiteralPath $errorFile -Raw -ErrorAction SilentlyContinue
      if ([string]::IsNullOrWhiteSpace($safeError)) {
        $safeError = "No PostgreSQL diagnostic was returned."
      }
      $safeError = [regex]::Replace($safeError, '(?i)postgres(?:ql)?://\S+', '[REDACTED_DATABASE_URL]')
      throw "Phase B cycle failed at $Label`: $safeError"
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
  Invoke-PsqlFile -Label "rpc-matrix-1" -Path $rpcMatrixTest
  Invoke-PsqlFile -Label "rollback" -Path $rollbackMigration
  Invoke-PsqlFile -Label "forward-2" -Path $forwardMigration
  Invoke-PsqlFile -Label "catalog-2" -Path $catalogTest
  Invoke-PsqlFile -Label "rpc-matrix-2" -Path $rpcMatrixTest

  [pscustomobject]@{
    Result = "passed"
    Sequence = "forward -> catalog/RPC -> rollback -> forward -> catalog/RPC"
    FinalFixtureState = "Phase B forward migration applied"
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
