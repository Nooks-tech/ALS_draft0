[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRef,

  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedRef = "rmslvptafkxywhpzpuxt"
$databaseUrlVariable = "PHASE_A_DATABASE_URL"

if ($ProjectRef -cne $expectedRef) {
  throw "Refusing snapshot: -ProjectRef must exactly equal Frankfurt ref $expectedRef."
}

$databaseUrl = [Environment]::GetEnvironmentVariable($databaseUrlVariable, "Process")
if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
  throw "Set $databaseUrlVariable in the current process to an explicit read-only Frankfurt PostgreSQL URL."
}

if ($databaseUrl -notmatch [regex]::Escape($expectedRef)) {
  throw "Refusing snapshot: $databaseUrlVariable does not contain the explicit Frankfurt project ref."
}

if ($databaseUrl -match [regex]::Escape("setynlgmdzaceegrlgwg")) {
  throw "Refusing snapshot: the supplied URL targets the Tokyo rollback project."
}

try {
  $parsedDatabaseUrl = [Uri]$databaseUrl
} catch {
  throw "$databaseUrlVariable is not a valid PostgreSQL URI."
}

if ($parsedDatabaseUrl.Scheme -notin @("postgres", "postgresql")) {
  throw "$databaseUrlVariable must use the postgres or postgresql URI scheme."
}

$psql = Get-Command "psql" -ErrorAction SilentlyContinue
if (-not $psql) {
  throw "psql was not found on PATH. Install a PostgreSQL client before capturing the snapshot."
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $downloads = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads"
  $stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
  $OutputPath = Join-Path $downloads "nooks_phase_a_frankfurt_prechange_$stamp.json"
}

$fullOutputPath = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($fullOutputPath) -cne ".json") {
  throw "Snapshot output must use a .json extension."
}

if ($fullOutputPath.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write the live catalog snapshot inside the repository. Choose a protected local path."
}

$outputDirectory = Split-Path -Parent $fullOutputPath
if (-not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

if (Test-Path -LiteralPath $fullOutputPath) {
  throw "Refusing to overwrite existing snapshot: $fullOutputPath"
}

$sql = @'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

WITH wanted(ordinal, signature) AS (
  VALUES
    (1,  'public.credit_customer_wallet(uuid,uuid,bigint,text,text,text,uuid,text)'),
    (2,  'public.debit_customer_wallet(uuid,uuid,bigint,text,text)'),
    (3,  'public.credit_sms_wallet_balance(uuid,integer,text,text,text,text,jsonb)'),
    (4,  'public.debit_sms_wallet_balance(uuid,integer,text,text,text,text,jsonb)'),
    (5,  'public.increment_loyalty_points(text,text,integer,integer)'),
    (6,  'public.increment_promo_usage(uuid,text)'),
    (7,  'public.redeem_promo(uuid,text,text,text,numeric,text)'),
    (8,  'public.unredeem_promo(uuid,text)'),
    (9,  'public.wallet_balance_mismatches()'),
    (10, 'public.enroll_merchant_customer(uuid,text,text)'),
    (11, 'public.expire_loyalty_cashback(text,text,numeric)'),
    (12, 'public.expire_loyalty_points(text,text,numeric)'),
    (13, 'public.get_migration_status()'),
    (14, 'public.get_user_email_confirmed(text)'),
    (15, 'public.redeem_loyalty_cashback(text,text,numeric,text,text,text,text,text,integer,uuid,text,text,jsonb)'),
    (16, 'public.redeem_loyalty_points(text,text,numeric,text,text,text,text,text,uuid,uuid,text,text,jsonb)')
),
function_rows AS (
  SELECT w.ordinal,
         w.signature,
         p.oid,
         n.nspname AS schema_name,
         p.proname,
         pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
         pg_catalog.pg_get_function_result(p.oid) AS result_type,
         l.lanname AS language_name,
         pg_catalog.pg_get_userbyid(p.proowner) AS owner_name,
         p.prosecdef AS security_definer,
         p.proleakproof AS leakproof,
         p.provolatile AS volatility,
         p.proparallel AS parallel_safety,
         p.proconfig,
         p.proacl::text AS raw_acl,
         pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) AS definition_md5,
         pg_catalog.pg_get_functiondef(p.oid) AS definition,
         pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
         pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
         pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute,
         (
           SELECT EXISTS (
             SELECT 1
               FROM pg_catalog.aclexplode(
                 COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
               ) AS public_acl
              WHERE public_acl.grantee = 0
                AND public_acl.privilege_type = 'EXECUTE'
           )
         ) AS public_execute,
         (
           SELECT COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'grantor', pg_catalog.pg_get_userbyid(acl.grantor),
                 'grantee', CASE
                   WHEN acl.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                 END,
                 'privilege_type', acl.privilege_type,
                 'is_grantable', acl.is_grantable
               )
               ORDER BY
                 CASE
                   WHEN acl.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                 END,
                 acl.privilege_type
             ),
             '[]'::jsonb
           )
             FROM pg_catalog.aclexplode(
               COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
             ) AS acl
         ) AS effective_acl_entries,
         (
           SELECT count(*)
             FROM pg_catalog.pg_trigger AS t
            WHERE t.tgfoid = p.oid
         ) AS trigger_binding_count
    FROM wanted AS w
    LEFT JOIN pg_catalog.pg_proc AS p
      ON p.oid = pg_catalog.to_regprocedure(w.signature)
    LEFT JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    LEFT JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
),
policies AS (
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'schemaname', schemaname,
               'tablename', tablename,
               'policyname', policyname,
               'permissive', permissive,
               'roles', roles,
               'command', cmd,
               'using_expression', qual,
               'check_expression', with_check
             )
             ORDER BY schemaname, tablename, policyname
           ),
           '[]'::jsonb
         ) AS rows
    FROM pg_catalog.pg_policies
),
table_grants AS (
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'grantor', grantor,
               'grantee', grantee,
               'table_schema', table_schema,
               'table_name', table_name,
               'privilege_type', privilege_type,
               'is_grantable', is_grantable,
               'with_hierarchy', with_hierarchy
             )
             ORDER BY table_schema, table_name, grantee, privilege_type
           ),
           '[]'::jsonb
         ) AS rows
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
),
default_acls AS (
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'owner', pg_catalog.pg_get_userbyid(d.defaclrole),
               'schema', n.nspname,
               'object_type', d.defaclobjtype,
               'raw_acl', d.defaclacl::text,
               'entries', (
                 SELECT COALESCE(
                   pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'grantor', pg_catalog.pg_get_userbyid(acl.grantor),
                       'grantee', CASE
                         WHEN acl.grantee = 0 THEN 'PUBLIC'
                         ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                       END,
                       'privilege_type', acl.privilege_type,
                       'is_grantable', acl.is_grantable
                     )
                     ORDER BY
                       CASE
                         WHEN acl.grantee = 0 THEN 'PUBLIC'
                         ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                       END,
                       acl.privilege_type
                   ),
                   '[]'::jsonb
                 )
                   FROM pg_catalog.aclexplode(d.defaclacl) AS acl
               )
             )
             ORDER BY pg_catalog.pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype
           ),
           '[]'::jsonb
         ) AS rows
    FROM pg_catalog.pg_default_acl AS d
    LEFT JOIN pg_catalog.pg_namespace AS n ON n.oid = d.defaclnamespace
),
function_json AS (
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.to_jsonb(function_rows) - 'ordinal'
             ORDER BY ordinal
           ),
           '[]'::jsonb
         ) AS rows
    FROM function_rows
)
SELECT pg_catalog.jsonb_pretty(
  pg_catalog.jsonb_build_object(
    'snapshot_kind', 'nooks_phase_a_frankfurt_prechange',
    'project_ref', 'rmslvptafkxywhpzpuxt',
    'captured_at_utc', pg_catalog.clock_timestamp(),
    'database', pg_catalog.jsonb_build_object(
      'database_name', pg_catalog.current_database(),
      'current_user', CURRENT_USER,
      'session_user', SESSION_USER,
      'server_version', pg_catalog.current_setting('server_version'),
      'transaction_read_only', pg_catalog.current_setting('transaction_read_only')
    ),
    'expected_baseline', pg_catalog.jsonb_build_object(
      'postgres_version', '17.6',
      'target_function_count', 16,
      'public_policy_count', 82,
      'total_policy_count', 103,
      'untrusted_and_service_table_grant_count', 1064,
      'increment_loyalty_points_definition_md5', '6d573c098528fe9b4d0126c0a3bf3533'
    ),
    'actual_counts', pg_catalog.jsonb_build_object(
      'target_functions', pg_catalog.jsonb_array_length(function_json.rows),
      'missing_target_functions', (
        SELECT count(*) FROM function_rows WHERE oid IS NULL
      ),
      'public_policies', (
        SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'public'
      ),
      'total_policies', pg_catalog.jsonb_array_length(policies.rows),
      'untrusted_and_service_table_grants', pg_catalog.jsonb_array_length(table_grants.rows),
      'default_acl_rows', pg_catalog.jsonb_array_length(default_acls.rows)
    ),
    'functions', function_json.rows,
    'policies', policies.rows,
    'table_grants', table_grants.rows,
    'default_acls', default_acls.rows
  )
)
FROM function_json, policies, table_grants, default_acls;

COMMIT;
'@

$secretPatterns = @(
  '(?i)\b(?:sbp_|sb_secret_|sk_live_|sk_test_|vcp_|railway_)[A-Za-z0-9._-]{8,}',
  '(?i)postgres(?:ql)?://[^\s:/]+:[^\s@]+@',
  '\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b',
  '(?i)\b(?:SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|CRON_SECRET|INTERNAL_API_SECRET)\s*[:=]\s*[^\s,}]+'
)

$oldConnectTimeout = $env:PGCONNECT_TIMEOUT
$errorFile = [IO.Path]::GetTempFileName()

try {
  $env:PGCONNECT_TIMEOUT = "15"

  $savedErrorActionPreference = $ErrorActionPreference
  $nativePreferenceExists = $null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue)
  if ($nativePreferenceExists) {
    $savedNativePreference = $PSNativeCommandUseErrorActionPreference
  }

  try {
    # A non-zero native exit is handled explicitly below after stderr is
    # captured and redacted. Do not let PowerShell terminate at the psql line.
    $ErrorActionPreference = "Continue"
    if ($nativePreferenceExists) {
      $PSNativeCommandUseErrorActionPreference = $false
    }
    # This host ignores PGDATABASE for psql, so pass the reviewed Frankfurt URL
    # directly as a native argument. PowerShell does not echo native arguments.
    $outputLines = $sql | & $psql.Source --dbname=$databaseUrl -X --quiet --no-align --tuples-only --set=ON_ERROR_STOP=1 2> $errorFile
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
    if ($nativePreferenceExists) {
      $PSNativeCommandUseErrorActionPreference = $savedNativePreference
    }
  }

  $json = ($outputLines -join [Environment]::NewLine).Trim()

  if ($exitCode -ne 0) {
    $safeError = (Get-Content -LiteralPath $errorFile -Raw -ErrorAction SilentlyContinue)
    if ([string]::IsNullOrWhiteSpace($safeError)) {
      $safeError = "No PostgreSQL diagnostic was returned."
    }
    $safeError = [regex]::Replace($safeError, '(?i)postgres(?:ql)?://\S+', '[REDACTED_DATABASE_URL]')
    throw "Read-only Frankfurt snapshot query failed: $safeError"
  }

  if ([string]::IsNullOrWhiteSpace($json)) {
    throw "Read-only Frankfurt snapshot query returned no JSON."
  }

  foreach ($pattern in $secretPatterns) {
    if ([regex]::IsMatch($json, $pattern)) {
      throw "Secret-pattern scan rejected the snapshot. Nothing was written."
    }
  }

  try {
    $convertFromJson = Get-Command ConvertFrom-Json
    if ($convertFromJson.Parameters.ContainsKey("Depth")) {
      $snapshot = $json | ConvertFrom-Json -Depth 100
    } else {
      # Windows PowerShell 5.1 does not expose ConvertFrom-Json -Depth.
      $snapshot = $json | ConvertFrom-Json
    }
  } catch {
    throw "Snapshot output was not valid JSON. Nothing was written."
  }

  if ($snapshot.snapshot_kind -cne "nooks_phase_a_frankfurt_prechange" -or
      $snapshot.project_ref -cne $expectedRef) {
    throw "Snapshot identity check failed. Nothing was written."
  }

  if ([int]$snapshot.actual_counts.target_functions -ne 16 -or
      [int]$snapshot.actual_counts.missing_target_functions -ne 0) {
    throw "Function inventory drift detected. Nothing was written."
  }

  [IO.File]::WriteAllText(
    $fullOutputPath,
    $json + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
  )

  $hash = (Get-FileHash -LiteralPath $fullOutputPath -Algorithm SHA256).Hash
  [pscustomobject]@{
    ProjectRef = $expectedRef
    OutputPath = $fullOutputPath
    Sha256 = $hash
    FunctionCount = [int]$snapshot.actual_counts.target_functions
    PublicPolicyCount = [int]$snapshot.actual_counts.public_policies
    TotalPolicyCount = [int]$snapshot.actual_counts.total_policies
    TableGrantCount = [int]$snapshot.actual_counts.untrusted_and_service_table_grants
    ReadOnly = $true
  }
} finally {
  if ($null -eq $oldConnectTimeout) {
    Remove-Item Env:PGCONNECT_TIMEOUT -ErrorAction SilentlyContinue
  } else {
    $env:PGCONNECT_TIMEOUT = $oldConnectTimeout
  }
  if (Test-Path -LiteralPath $errorFile) {
    Remove-Item -LiteralPath $errorFile -Force
  }
  $databaseUrl = $null
}
