[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$databaseUrlVariable = "MIGRATION_REGISTRY_TEST_DATABASE_URL"
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
  throw "Refusing registry cycle: the fixture URL must target a loopback PostgreSQL host."
}

if ($databaseUrl -match '(?i)supabase\.co|rmslvptafkxywhpzpuxt|setynlgmdzaceegrlgwg') {
  throw "Refusing registry cycle: Supabase projects are never test fixtures."
}

$psql = Get-Command "psql" -ErrorAction SilentlyContinue
if (-not $psql) {
  throw "psql was not found on PATH."
}

$supabaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$migrationsRoot = Join-Path $supabaseRoot "migrations"
$rollback = Join-Path $supabaseRoot "rollbacks\20260715190000_migration_registry_reconciliation.rollback.sql"
$catalogTest = Join-Path $PSScriptRoot "migration_registry_reconciliation.sql"
$semanticTest = Join-Path $PSScriptRoot "migration_registry_reconciliation_semantics.sql"
$deploymentVersions = @(
  "20260715160000",
  "20260715170000",
  "20260715180000",
  "20260715190000"
)

$deploymentFiles = @()
foreach ($version in $deploymentVersions) {
  $matches = @(Get-ChildItem -LiteralPath $migrationsRoot -File -Filter ($version + "_*.sql"))
  if ($matches.Count -ne 1) {
    throw "Expected exactly one ALS migration for $version, found $($matches.Count)."
  }
  $deploymentFiles += $matches[0]
}

foreach ($file in @($rollback, $catalogTest, $semanticTest)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "Missing registry cycle artifact: $file"
  }
}

$releaseRows = @()
foreach ($file in $deploymentFiles) {
  $name = $file.BaseName.Substring(15)
  if ($name -notmatch '^[a-z0-9_]+$') {
    throw "Migration name is not canonical: $($file.Name)"
  }
  $releaseRows += [ordered]@{
    version = $file.BaseName.Substring(0, 14)
    name = $name
    sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

$manifestLines = @(
  $releaseRows |
    Sort-Object version, name, sha256 |
    ForEach-Object {
      "ALS|$($_.version)|$($_.name)|$($_.sha256)|AUTHORITATIVE_DEPLOYMENT"
    }
)
$manifestText = $manifestLines -join [char]10
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $manifestDigest = ([BitConverter]::ToString(
    $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($manifestText))
  )).Replace("-", "").ToLowerInvariant()
} finally {
  $sha.Dispose()
}

$releaseJson = $releaseRows | ConvertTo-Json -Compress
$attestationSql = @"
SELECT *
FROM public.attest_nooks_schema_deployment(
  '$manifestDigest',
  '$releaseJson'::jsonb
);
"@

$attestationFile = [IO.Path]::GetTempFileName()
[IO.File]::WriteAllText(
  $attestationFile,
  $attestationSql,
  [Text.UTF8Encoding]::new($false)
)

function Invoke-PsqlFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,

    [Parameter(Mandatory = $true)]
    [string]$Path,

    [switch]$ExpectRollbackRefusal
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

    $safeError = Get-Content -LiteralPath $errorFile -Raw -ErrorAction SilentlyContinue
    $safeError = [regex]::Replace(
      [string]$safeError,
      '(?i)postgres(?:ql)?://\S+',
      '[REDACTED_DATABASE_URL]'
    )

    if ($ExpectRollbackRefusal) {
      if ($exitCode -eq 0 -or
          $safeError -notmatch 'refusing registry rollback') {
        throw "Registry rollback did not fail closed as expected: $safeError"
      }
      return
    }

    if ($exitCode -ne 0) {
      if ([string]::IsNullOrWhiteSpace($safeError)) {
        $safeError = "No PostgreSQL diagnostic was returned."
      }
      throw "Registry cycle failed at $($Label): $safeError"
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

  foreach ($file in $deploymentFiles) {
    Invoke-PsqlFile -Label "prerequisite-$($file.BaseName)" -Path $file.FullName
  }

  Invoke-PsqlFile -Label "attest-finalized-deployment" -Path $attestationFile
  Invoke-PsqlFile -Label "catalog-1" -Path $catalogTest
  Invoke-PsqlFile -Label "semantic-1" -Path $semanticTest
  Invoke-PsqlFile -Label "rollback-refusal" -Path $rollback -ExpectRollbackRefusal

  Invoke-PsqlFile -Label "registry-forward-idempotent" -Path $deploymentFiles[-1].FullName
  Invoke-PsqlFile -Label "attestation-idempotent" -Path $attestationFile
  Invoke-PsqlFile -Label "catalog-2" -Path $catalogTest
  Invoke-PsqlFile -Label "semantic-2" -Path $semanticTest

  [pscustomobject]@{
    Result = "passed"
    Sequence = "B/C/D/registry -> deployment attestation -> catalog/semantic -> guarded rollback refusal -> idempotent registry/attestation -> catalog/semantic"
    HistoricalManifest = "d939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493"
    DeploymentManifest = $manifestDigest
    DeploymentReleases = $releaseRows.Count
    PendingUnprovenHistory = 42
    FinalFixtureState = "registry migration and finalized deployment attestation applied"
    Host = $parsedDatabaseUrl.Host
  }
} finally {
  if ($null -eq $oldConnectTimeout) {
    Remove-Item Env:PGCONNECT_TIMEOUT -ErrorAction SilentlyContinue
  } else {
    $env:PGCONNECT_TIMEOUT = $oldConnectTimeout
  }
  if (Test-Path -LiteralPath $attestationFile) {
    Remove-Item -LiteralPath $attestationFile -Force
  }
  $databaseUrl = $null
}

