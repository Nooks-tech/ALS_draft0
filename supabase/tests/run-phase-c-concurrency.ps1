param(
  [Parameter(Mandatory = $true)]
  [string]$DatabaseUrl
)

$ErrorActionPreference = 'Stop'

if ($env:PHASE_C_ALLOW_DESTRUCTIVE_TEST_DB -ne 'YES') {
  throw 'Set PHASE_C_ALLOW_DESTRUCTIVE_TEST_DB=YES for a disposable local database.'
}

$uri = [Uri]$DatabaseUrl
if ($uri.Scheme -notin @('postgres', 'postgresql') -or
    $uri.Host -notin @('localhost', '127.0.0.1', '::1')) {
  throw 'Phase C concurrency tests are restricted to a disposable localhost PostgreSQL database.'
}

$psql = (Get-Command psql -ErrorAction Stop).Source
$pgbench = (Get-Command pgbench -ErrorAction Stop).Source
$testDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$previousPgOptions = $env:PGOPTIONS
$env:PGOPTIONS = '-c phase_c.allow_destructive_test=on'

try {
  & $psql $DatabaseUrl -X -v ON_ERROR_STOP=1 -f (Join-Path $testDir 'phase_c_concurrency_setup.sql')
  if ($LASTEXITCODE -ne 0) { throw 'Phase C concurrency setup failed.' }

  # Exactly 100 PostgreSQL clients, each mapped to a distinct attempt. Ninety-nine
  # transactions are expected to fail with insufficient balance; the SQL assert
  # proves exactly one durable winner and conservation.
  & $pgbench $DatabaseUrl -n -c 100 -j 20 -t 1 -f (Join-Path $testDir 'phase_c_concurrency_reserve.pgbench.sql')

  & $psql $DatabaseUrl -X -v ON_ERROR_STOP=1 -f (Join-Path $testDir 'phase_c_concurrency_prepare_race.sql')
  if ($LASTEXITCODE -ne 0) { throw 'Phase C reserve-race assertion failed.' }

  # A second 100-client wave races terminal release against process replay.
  & $pgbench $DatabaseUrl -n -c 100 -j 20 -t 1 -f (Join-Path $testDir 'phase_c_concurrency_release_replay.pgbench.sql')

  & $psql $DatabaseUrl -X -v ON_ERROR_STOP=1 -f (Join-Path $testDir 'phase_c_concurrency_assert.sql')
  if ($LASTEXITCODE -ne 0) { throw 'Phase C release/replay assertion failed.' }
}
finally {
  $env:PGOPTIONS = $previousPgOptions
}
