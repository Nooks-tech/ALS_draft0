[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$supabaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$migrationsRoot = Join-Path $supabaseRoot "migrations"
$versions = @(
  "20260715160000",
  "20260715170000",
  "20260715180000",
  "20260715190000"
)

$releases = @()
foreach ($version in $versions) {
  $files = @(Get-ChildItem -LiteralPath $migrationsRoot -File -Filter ($version + "_*.sql"))
  if ($files.Count -ne 1) {
    throw "Expected exactly one finalized ALS migration for $version, found $($files.Count)."
  }

  $file = $files[0]
  $name = $file.BaseName.Substring(15)
  if ($name -notmatch '^[a-z0-9_]+$') {
    throw "Migration name is not canonical: $($file.Name)"
  }

  # NOTE: must be a pscustomobject, not [ordered]@{}. Sort-Object cannot sort a
  # hashtable/OrderedDictionary by a property name — it silently keeps a wrong
  # order, producing a manifest digest that mismatches the on-chain
  # attest_nooks_schema_deployment() canonicalization (ORDER BY version,name,sha256).
  $releases += [pscustomobject]@{
    version = $version
    name = $name
    sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

$canonicalLines = @(
  $releases |
    Sort-Object version, name, sha256 |
    ForEach-Object {
      "ALS|$($_.version)|$($_.name)|$($_.sha256)|AUTHORITATIVE_DEPLOYMENT"
    }
)
$canonicalText = $canonicalLines -join [char]10
$hasher = [Security.Cryptography.SHA256]::Create()
try {
  $digest = ([BitConverter]::ToString(
    $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonicalText))
  )).Replace("-", "").ToLowerInvariant()
} finally {
  $hasher.Dispose()
}

$json = $releases | ConvertTo-Json -Compress
$sql = @"
SELECT *
FROM public.attest_nooks_schema_deployment(
  '$digest',
  '$json'::jsonb
);
"@

[pscustomobject]@{
  ManifestSha256 = $digest
  ReleaseCount = $releases.Count
  CanonicalLines = $canonicalLines
  ReleasesJson = $json
  Sql = $sql
}

