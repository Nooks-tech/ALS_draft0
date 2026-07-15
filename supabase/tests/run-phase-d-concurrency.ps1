param(
  [Parameter(Mandatory = $true)]
  [string]$DatabaseUrl
)

$ErrorActionPreference = 'Stop'

if ($env:PHASE_D_ALLOW_DESTRUCTIVE_TEST_DB -ne 'YES') {
  throw 'Set PHASE_D_ALLOW_DESTRUCTIVE_TEST_DB=YES for a disposable local database.'
}

$uri = [Uri]$DatabaseUrl
if ($uri.Scheme -notin @('postgres', 'postgresql') -or
    $uri.Host -notin @('localhost', '127.0.0.1', '::1')) {
  throw 'Phase D concurrency tests are restricted to a disposable localhost PostgreSQL database.'
}

$psql = (Get-Command psql -ErrorAction Stop).Source
$pgbench = (Get-Command pgbench -ErrorAction Stop).Source
$testDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$previousPgOptions = $env:PGOPTIONS
$env:PGOPTIONS = '-c phase_d.allow_destructive_test=on'

try {
  & $psql $DatabaseUrl -X -v ON_ERROR_STOP=1 -f (Join-Path $testDir 'phase_d_concurrency_setup.sql')
  if ($LASTEXITCODE -ne 0) { throw 'Phase D concurrency setup failed.' }

  # Exactly 100 clients, each opening a distinct partial_refund command adding a
  # card component against one shared basis. The per-rail budget CHECK aborts the
  # ~50 that would breach the cap; the SQL assert proves no overshoot + conservation.
  & $pgbench $DatabaseUrl -n -c 100 -j 20 -t 1 -f (Join-Path $testDir 'phase_d_concurrency_budget.pgbench.sql')

  & $psql $DatabaseUrl -X -v ON_ERROR_STOP=1 -f (Join-Path $testDir 'phase_d_concurrency_assert.sql')
  if ($LASTEXITCODE -ne 0) { throw 'Phase D budget-cap assertion failed.' }
}
finally {
  $env:PGOPTIONS = $previousPgOptions
}
