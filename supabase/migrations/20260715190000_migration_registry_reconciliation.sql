-- 20260715190000: collision-safe cross-repository inventory and drift repair.
--
-- This migration does not rewrite supabase_migrations.schema_migrations. That
-- built-in registry is keyed only by version and cannot represent the 12
-- cross-repository version collisions diagnosed on 2026-07-15.
--
-- ALS is the authority for future shared-database migrations. WEB rows below
-- are immutable historical inventory only. A row is never called applied based
-- on file presence alone: registry observation and reconciliation status remain
-- separate, and pending_unproven stays visible to /ready.

SET statement_timeout = '90s';
SET lock_timeout = '5s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('nooks:shared-schema-registry:v1', 0)
);

DO $registry_preflight$
DECLARE
  required_relation text;
  required_column record;
BEGIN
  IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'registry reconciliation requires supabase_migrations.schema_migrations';
  END IF;

  IF pg_catalog.to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'registry reconciliation requires extensions.digest(bytea,text)';
  END IF;

  FOREACH required_relation IN ARRAY ARRAY[
    'public.orders',
    'public.product_categories',
    'public.branch_operations',
    'public.merchants',
    'public.merchant_customers',
    'public.loyalty_member_profiles',
    'public.loyalty_points',
    'public.loyalty_cashback_balances',
    'public.customer_orders'
  ]
  LOOP
    IF pg_catalog.to_regclass(required_relation) IS NULL THEN
      RAISE EXCEPTION 'registry reconciliation prerequisite is missing: %', required_relation;
    END IF;
  END LOOP;

  FOR required_column IN
    SELECT *
      FROM (VALUES
        ('orders', 'branch_id'),
        ('product_categories', 'merchant_id'),
        ('branch_operations', 'delivery_enabled'),
        ('branch_operations', 'pickup_enabled'),
        ('branch_operations', 'drivethru_enabled'),
        ('merchant_customers', 'merchant_id'),
        ('merchant_customers', 'customer_id'),
        ('merchant_customers', 'enrolled_via'),
        ('merchant_customers', 'enrolled_at'),
        ('loyalty_member_profiles', 'merchant_id'),
        ('loyalty_member_profiles', 'customer_id'),
        ('loyalty_member_profiles', 'created_at'),
        ('loyalty_points', 'merchant_id'),
        ('loyalty_points', 'customer_id'),
        ('loyalty_points', 'created_at'),
        ('loyalty_cashback_balances', 'merchant_id'),
        ('loyalty_cashback_balances', 'customer_id'),
        ('loyalty_cashback_balances', 'updated_at'),
        ('customer_orders', 'merchant_id'),
        ('customer_orders', 'customer_id'),
        ('customer_orders', 'created_at')
      ) AS expected(table_name, column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.columns AS c
       WHERE c.table_schema = 'public'
         AND c.table_name = required_column.table_name
         AND c.column_name = required_column.column_name
    ) THEN
      RAISE EXCEPTION
        'registry reconciliation prerequisite column is missing: public.%.%',
        required_column.table_name,
        required_column.column_name;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('public.loyalty_stamp_redemptions') IS NOT NULL THEN
    RAISE EXCEPTION
      'loyalty_stamp_redemptions unexpectedly exists; obsolete-history attestation is no longer valid';
  END IF;
END
$registry_preflight$;

CREATE TABLE IF NOT EXISTS public.nooks_schema_manifests (
  manifest_sha256 text PRIMARY KEY,
  manifest_kind text NOT NULL,
  inventory_row_count integer NOT NULL,
  authority_repository text NOT NULL,
  source_project_ref text NOT NULL,
  inventory_observed_at timestamptz NOT NULL,
  expected_registered_exact integer NOT NULL,
  expected_live_effect_attested integer NOT NULL,
  expected_superseded_obsolete integer NOT NULL,
  expected_pending_unproven integer NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  installed_by text NOT NULL DEFAULT CURRENT_USER,
  CONSTRAINT nooks_schema_manifests_sha256_check
    CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT nooks_schema_manifests_kind_check
    CHECK (manifest_kind IN ('historical_inventory', 'deployment')),
  CONSTRAINT nooks_schema_manifests_authority_check
    CHECK (authority_repository = 'ALS'),
  CONSTRAINT nooks_schema_manifests_counts_check
    CHECK (
      inventory_row_count > 0
      AND expected_registered_exact >= 0
      AND expected_live_effect_attested >= 0
      AND expected_superseded_obsolete >= 0
      AND expected_pending_unproven >= 0
      AND expected_registered_exact
        + expected_live_effect_attested
        + expected_superseded_obsolete
        + expected_pending_unproven = inventory_row_count
    )
);

CREATE TABLE IF NOT EXISTS public.nooks_schema_releases (
  manifest_sha256 text NOT NULL
    REFERENCES public.nooks_schema_manifests(manifest_sha256),
  inventory_ordinal integer NOT NULL,
  repository text NOT NULL,
  migration_version text NOT NULL,
  migration_name text NOT NULL,
  source_sha256 text NOT NULL,
  inventory_status text NOT NULL,
  attestation_status text NOT NULL,
  evidence_code text NOT NULL,
  historical_inventory boolean NOT NULL DEFAULT false,
  attested_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  recorded_by text NOT NULL DEFAULT CURRENT_USER,
  PRIMARY KEY (repository, migration_version, migration_name, source_sha256),
  UNIQUE (manifest_sha256, inventory_ordinal),
  CONSTRAINT nooks_schema_releases_repository_check
    CHECK (repository IN ('ALS', 'WEB')),
  CONSTRAINT nooks_schema_releases_authority_check
    CHECK (historical_inventory OR repository = 'ALS'),
  CONSTRAINT nooks_schema_releases_version_check
    CHECK (migration_version ~ '^[0-9]{14}$'),
  CONSTRAINT nooks_schema_releases_name_check
    CHECK (migration_name ~ '^[a-z0-9_]+$'),
  CONSTRAINT nooks_schema_releases_hash_check
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT nooks_schema_releases_inventory_status_check
    CHECK (
      inventory_status = 'REGISTERED_NAME_MATCH'
      OR inventory_status = 'MISSING_VERSION'
      OR inventory_status = 'AUTHORITATIVE_DEPLOYMENT'
      OR inventory_status ~ '^VERSION_OCCUPIED_BY_[a-z0-9_]+$'
    ),
  CONSTRAINT nooks_schema_releases_attestation_status_check
    CHECK (
      attestation_status IN (
        'registered_exact',
        'live_effect_attested',
        'superseded_obsolete',
        'pending_unproven'
      )
    ),
  CONSTRAINT nooks_schema_releases_evidence_check
    CHECK (
      (attestation_status = 'registered_exact'
        AND inventory_status = 'REGISTERED_NAME_MATCH'
        AND evidence_code = 'registry_identity_match'
        AND attested_at IS NOT NULL)
      OR
      (attestation_status = 'live_effect_attested'
        AND evidence_code IN (
          'terminal_effect_audit_20260715',
          'terminal_repair_20260715',
          'authoritative_deployment_attestation'
        )
        AND attested_at IS NOT NULL)
      OR
      (attestation_status = 'superseded_obsolete'
        AND evidence_code = 'superseded_terminal_state_20260715'
        AND attested_at IS NOT NULL)
      OR
      (attestation_status = 'pending_unproven'
        AND evidence_code = 'inventory_only'
        AND attested_at IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS public.nooks_schema_effect_attestations (
  effect_key text PRIMARY KEY,
  repository text NOT NULL,
  migration_version text NOT NULL,
  migration_name text NOT NULL,
  source_sha256 text NOT NULL,
  effect_status text NOT NULL,
  evidence jsonb NOT NULL,
  attested_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  attested_by text NOT NULL DEFAULT CURRENT_USER,
  FOREIGN KEY (repository, migration_version, migration_name, source_sha256)
    REFERENCES public.nooks_schema_releases(
      repository,
      migration_version,
      migration_name,
      source_sha256
    ),
  CONSTRAINT nooks_schema_effect_attestations_status_check
    CHECK (effect_status IN ('repaired_present', 'superseded_obsolete')),
  CONSTRAINT nooks_schema_effect_attestations_evidence_check
    CHECK (pg_catalog.jsonb_typeof(evidence) = 'object')
);

COMMENT ON TABLE public.nooks_schema_manifests IS
  'Immutable logical migration inventories. ALS is the authority for future shared-database migration files.';
COMMENT ON TABLE public.nooks_schema_releases IS
  'Collision-safe release ledger keyed by repository, version, name, and source SHA-256. pending_unproven is intentionally not applied.';
COMMENT ON COLUMN public.nooks_schema_releases.inventory_status IS
  'Exact observation copied from the 2026-07-15 inventory, separate from effect attestation.';
COMMENT ON COLUMN public.nooks_schema_releases.attestation_status IS
  'registered_exact means unambiguous built-in version/name identity; source SHA remains repository inventory, not a hash stored by Supabase.';
COMMENT ON TABLE public.nooks_schema_effect_attestations IS
  'Immutable proof records for narrowly repaired or explicitly superseded terminal effects.';

CREATE OR REPLACE FUNCTION public.reject_nooks_schema_registry_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION
    'nooks schema registry rows are immutable; append a new ALS-authority manifest or attestation'
    USING ERRCODE = '55000';
END
$function$;

REVOKE ALL ON FUNCTION public.reject_nooks_schema_registry_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS nooks_schema_manifests_immutable
  ON public.nooks_schema_manifests;
CREATE TRIGGER nooks_schema_manifests_immutable
BEFORE UPDATE OR DELETE ON public.nooks_schema_manifests
FOR EACH ROW EXECUTE FUNCTION public.reject_nooks_schema_registry_mutation();

DROP TRIGGER IF EXISTS nooks_schema_releases_immutable
  ON public.nooks_schema_releases;
CREATE TRIGGER nooks_schema_releases_immutable
BEFORE UPDATE OR DELETE ON public.nooks_schema_releases
FOR EACH ROW EXECUTE FUNCTION public.reject_nooks_schema_registry_mutation();

DROP TRIGGER IF EXISTS nooks_schema_effect_attestations_immutable
  ON public.nooks_schema_effect_attestations;
CREATE TRIGGER nooks_schema_effect_attestations_immutable
BEFORE UPDATE OR DELETE ON public.nooks_schema_effect_attestations
FOR EACH ROW EXECUTE FUNCTION public.reject_nooks_schema_registry_mutation();

ALTER TABLE public.nooks_schema_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nooks_schema_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.nooks_schema_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nooks_schema_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.nooks_schema_effect_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nooks_schema_effect_attestations FORCE ROW LEVEL SECURITY;

-- 2026-07-15 audit fix (consistency companion to F21): matches the same
-- explicit-policy convention added to the Phase B/C migrations. Not
-- currently live-breaking (server/utils/migrationStatus.ts only calls
-- get_migration_status(), never queries these tables directly, and FORCE
-- ROW LEVEL SECURITY is bypassed for genuine superuser roles regardless),
-- but leaving this migration as the one outlier without policies would be
-- a latent trap for any future direct read added here.
DROP POLICY IF EXISTS "service_role_all" ON public.nooks_schema_manifests;
CREATE POLICY "service_role_all" ON public.nooks_schema_manifests
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.nooks_schema_releases;
CREATE POLICY "service_role_all" ON public.nooks_schema_releases
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.nooks_schema_effect_attestations;
CREATE POLICY "service_role_all" ON public.nooks_schema_effect_attestations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.nooks_schema_manifests
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.nooks_schema_releases
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.nooks_schema_effect_attestations
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TEMPORARY TABLE nooks_schema_release_seed (
  inventory_ordinal integer PRIMARY KEY,
  repository text NOT NULL,
  migration_version text NOT NULL,
  migration_name text NOT NULL,
  source_sha256 text NOT NULL,
  inventory_status text NOT NULL,
  attestation_status text NOT NULL,
  evidence_code text NOT NULL
) ON COMMIT DROP;

INSERT INTO pg_temp.nooks_schema_release_seed (
  inventory_ordinal,
  repository,
  migration_version,
  migration_name,
  source_sha256,
  inventory_status,
  attestation_status,
  evidence_code
)
VALUES
(1, 'ALS', '20260216000000', 'create_promo_codes', '8bdbf109dfc4f8ae0fca9e343620011e57253495591e89b49664c090fb30f17a', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (2, 'ALS', '20260217000000', 'create_profiles', '665b34b4daf704979e6eddd829270f53cfb1024fdb420e4794c4afb3479c9fe8', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (3, 'WEB', '20260217000001', 'create_merchants', '8d7093acf27dcadfde91d7ca26b0ed7b45322a5aa75686844ee5fd6425ddcec1', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (4, 'WEB', '20260217000002', 'create_app_config', '66e551dfb18bcece721cb5342c52e6eeb400c60bcd8b14e1c440d13cd307ec5e', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (5, 'WEB', '20260217000003', 'storage_merchant_logos', 'fa35c2cad09b540b3d7e4c5ccad301ae0a5803115371ed77c0501a116806edf7', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (6, 'ALS', '20260217100000', 'create_email_otp', 'b8faf7af3d00c614ee679d095bd6f9343bed9044edab0772b66e4962c97ee2ae', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (7, 'WEB', '20260217100000', 'dashboard_tables', 'bedef3fe570eec78726c137c7aba2d23e1dbeb614c96bcd51b2e56c8e88eb4e0', 'VERSION_OCCUPIED_BY_create_email_otp', 'pending_unproven', 'inventory_only'),
  (8, 'WEB', '20260217100001', 'banners_bucket', '3b992a1d357b22c1ea4483a5fefab3925c73b22552429f98a420a6ef6aaf79a4', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (9, 'WEB', '20260217100002', 'dashboard_tables_only', '7a4ea2eaf14c472adb3b49c6e3fdf91cf9fc81e3198ddcff62c7fdd703f298dc', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (10, 'WEB', '20260217100003', 'trigger_create_merchant_on_signup', '70ef573dd29344dcf7d395b4348ccfc2bf41adcd94d636b06ff492bb6fc145c0', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (11, 'WEB', '20260217100004', 'foodics_subscription_tier', 'b5c81f97b686fd33da997dc0e556b489dd609cf0afd80da81413bf079251b4d4', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (12, 'WEB', '20260217100005', 'app_config_delivery_mode', '4684242ddc682814d4fad7b542ef924d76314da695364f1b1d058c2d0673e796', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (13, 'WEB', '20260217100006', 'audit_log', 'da363b60e15e6a425f3feb518235cf84c44238e543970e89046e332c3457a6f2', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (14, 'ALS', '20260218000000', 'create_customer_orders', 'a817b12976aec097aa3dbea66b9d2a7f3bbac59550770b271daf6b8ac1fe8162', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (15, 'ALS', '20260218000001', 'create_als_promo_codes', '101b2e177c0999df75544b7ec7b726e3b68979e2213a249bf2e247f616726bf7', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (16, 'WEB', '20260219100000', 'orders_branch_delivery', '3dc1c496347f5bbc9f9cdd7e6f89db37d84f6127da3b52e9e99283f6a8d24c9b', 'MISSING_VERSION', 'live_effect_attested', 'terminal_repair_20260715'),
  (17, 'WEB', '20260219110000', 'promo_codes_public_view', 'a4bfc569e9e08ae90068d6f047427545ca19a3c1b3dfe1ac1e13a69308e2d440', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (18, 'WEB', '20260220100000', 'banners_placement', '0a40658dd954f6a46bbcf219b7e105b42cf1a9eed1f5ecf6cffc3f8e47316917', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (19, 'WEB', '20260222000000', 'app_config_background_color', '1a1eb18adb173848824af6f1cd2bd11fe8e32d6e7f6ef3e7c13b0b9731bdbd73', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (20, 'WEB', '20260222100000', 'orders_driver_location', '0c9b5f116f08f589d7701fe34b1229ea38ceae9b4456d3949bf78d952192122f', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (21, 'WEB', '20260222200000', 'subscriptions', '41c4ca367be7becc02cd06645a99d26cec1780bcae8bd1606d9ced8cccd7f437', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (22, 'WEB', '20260222200001', 'product_categories', '3bccd45c60a8d2815c14c71ad10e89c85fdf6da8526daba20d98a8a4dede8cd8', 'MISSING_VERSION', 'live_effect_attested', 'terminal_repair_20260715'),
  (23, 'WEB', '20260222200002', 'increment_promo_usage', '9c8c191c7eb9ebee935542623945511c603ed9363de7c281215542dd8c70e1cb', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (24, 'WEB', '20260226000000', 'push_subscriptions', 'a8eb9e0738972a708f29c9728a8b6d9be92925c35488fb2fac1f78aef07a5abb', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (25, 'WEB', '20260228090000', 'promo_codes_image', '055f5a0024f6a43bebe167990cecd38335bf9e20cec274027d7551cbf6ad69ab', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (26, 'WEB', '20260228090500', 'app_config_busy_started_at', 'd7209019ca03bcd3884f852c6405f6649a927f39ab6f016a3dce0e8d7ff1a32e', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (27, 'WEB', '20260228120000', 'app_config_surface_text_colors', '1ea2354a46716283532d327eeba8aa2e896d5c181debe861023bb366ef26b064', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (28, 'WEB', '20260302050000', 'app_config_app_name_icon', 'd729543c297d0dbaf82b97e4aae58cf5002d1c0cfa831904d6d15310e4f1ead7', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (29, 'ALS', '20260307000000', 'create_sms_otp', '49ac6834d4be0422986fe65c58177abdd40977bdfc32e8283a23812ff2223890', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (30, 'WEB', '20260307120000', 'app_config_icon_bg_color', '165501efefcd0626bbac679c60f05423a2bc551c6928e69b026b2ad74c038eb0', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (31, 'ALS', '20260308000000', 'refunds_complaints', '660406e4b01759882bea874a03ef72e8be40139fdbba555da4c276dc4c6bf7f6', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (32, 'WEB', '20260308000000', 'app_config_tab_text_color', 'a05c7dc7708ee872091cd793c98666b12fcc26b241a39e4acbbd929ba6185a2b', 'VERSION_OCCUPIED_BY_refunds_complaints', 'pending_unproven', 'inventory_only'),
  (33, 'WEB', '20260308000001', 'merchants_go_live_fields', '4e48468ef4fe2fe90c0daede3fbb5409155ea67c2dcf0f145acc296c1af7d484', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (34, 'WEB', '20260309000000', 'app_config_logo_scales', '70e2561987c2f3e1cd5a456e66f08df8d3bec78e4c1a1174462fd6f7c9fbca30', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (35, 'ALS', '20260312000000', 'full_system_migration', 'a3b24771a39784fe4058765e232efbbd2c2ae55a35e1c92fd9113d17f25e4c56', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (36, 'ALS', '20260314000000', 'loyalty_system', '34a40b4d109642b649777d6b572a61365bb7d92497a0047eb315b5fea1b474d5', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (37, 'ALS', '20260315000000', 'team_members', '6cc7f6a95d4c93abc902d8f8d3421d0cfd0baa0198bacfa7bd755a6addfe22a8', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (38, 'ALS', '20260321000000', 'loyalty_wallet_card_logo_scale', '1c582e89392ec244452e7753390cf4432d262c2638fce462e53318693c7d99bf', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (39, 'WEB', '20260325000000', 'team_members_branch_operations', '6074382842b37a41a2ca5a765123c63235e5ee2f2ce4ee6eaa71b504141bbbf7', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (40, 'WEB', '20260326110000', 'saas_branch_billing_and_integrations', 'b8717fd9f2d539b4cdc3a4d83b42470bdebc9aa4a101638358d890a9dddb544c', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (41, 'WEB', '20260327160000', 'sms_wallet', '0f2fa206d345e94d0984373d19ee769427723f9e7b75e23ee45b868e65da5983', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (42, 'WEB', '20260328123000', 'sms_wallet_otp_charge_15_halalas', '53baf78dcaceaeddc4999c4470cddaf684e20cbc7f467cc5b59aeee794e02cbc', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (43, 'WEB', '20260328150000', 'subscription_renewals', '555ac3b51a6c5aa0a8c6f0024846d0589142f425ed28f2d1ab0e7e49ea649058', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (44, 'ALS', '20260328180000', 'pitch_readiness_hardening', 'e554d5272463031808a2943ecd6c65c3a4489d6d5afbe174219f3952da5d7341', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (45, 'WEB', '20260328193000', 'foodics_menu_hardening', '62f37c34047ba8ad33b443e7b475e5a5a50bb22db3aaac35b3c549b7c9814749', 'MISSING_VERSION', 'pending_unproven', 'inventory_only'),
  (46, 'ALS', '20260328203000', 'branch_loyalty_member_profiles', 'e6a88fe7bcb8ccaed7dcc2d768f6acf6e3599670825c9c50913847f775aa6c09', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (47, 'ALS', '20260329000000', 'eight_system_gaps', '13d59025d142f7c9180190891fcbce6a03fea28f2bc08ad2a90d564ea5edb20f', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (48, 'ALS', '20260329100000', 'remaining_gaps', 'cce43950b572482df4a1e0ea0fedb4c8cafb0ed453f403d739d29e0849e6f08c', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (49, 'ALS', '20260330000000', 'loyalty_three_systems', '59a014f6c7050dff976506520312cf07a468066a035d416e1f3e622c8ff2ae43', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (50, 'ALS', '20260331000000', 'loyalty_customer_transitions', '48e235e875095344cdd2598cb91cd068cc8e906310b64a10c361ebc8cbcdbf5e', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (51, 'ALS', '20260331000001', 'customer_saved_cards', '792376ac21831a49a971076947460a3979f2fe4318cdf67a79a891fc2082fcf6', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (52, 'ALS', '20260331000002', 'driver_info_columns', '72eb109589e4aa838c182f14b365be947be2d45c41c6c6da69ccdddf9684f436', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (53, 'ALS', '20260331000003', 'max_cashback_cap', '3b3c5465b112c86577796fd811fc524a09ad341ea0aa842359a68bdba2b30338', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (54, 'ALS', '20260331000004', 'allergen_nutrition_columns', '25c4bcb1cda09636f7ffead944e07cf9eb500528b2f45a42ea9f78d9c54bcc1e', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (55, 'ALS', '20260401000000', 'delivery_preferred_carriers', '2c01beff575134e76e8d7c3c1ce6e0aa4600795ea76be203963ae929109513d0', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (56, 'ALS', '20260401100000', 'foodics_localization_hours_stock', '155ee37209ca5c7f555312a0f7d6913765c963e39905e895402af235fcdd83d7', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (57, 'ALS', '20260403000000', 'fix_loyalty_transactions_type_check', '922bdb360038db30320f5c9d66a437c810b5cd6b3349f6d65a5339b04c4bd0a0', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (58, 'ALS', '20260403100000', 'loyalty_per_customer_type', '4e4d1bd446717835419fe3f316fc17198075bd3b45ed34b6ea902c1256661b39', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (59, 'ALS', '20260404000000', 'remove_points_loyalty_type', '21e013f199a4c73c7ccd30185243a062c65c79d213d53e4f0a998437f381edef', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (60, 'ALS', '20260408000000', 'webhook_events', '77bba9f0a1d9b93786d2aa7d3f442b93ba35fde0826a6d5646d1c92a5f59b265', 'REGISTERED_NAME_MATCH', 'pending_unproven', 'inventory_only'),
  (61, 'WEB', '20260408000000', 'webhook_events', '6f9480b0942b35f8f60dae68ca4fb529bdfa0e11572e4466bb55779ac22b77e1', 'REGISTERED_NAME_MATCH', 'pending_unproven', 'inventory_only'),
  (62, 'ALS', '20260408000001', 'dispatch_retry_columns', '951e8ed663d152679ba192c65ec9cb585e8693f5bce9e9617cd9856227937c2e', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (63, 'WEB', '20260408000001', 'subscription_renewal_lock', '172cf27ab90b4404e83a618f8b276cae31a02097cf39d5d6c6ccf3a2448c89d2', 'VERSION_OCCUPIED_BY_dispatch_retry_columns', 'pending_unproven', 'inventory_only'),
  (64, 'WEB', '20260408000002', 'dispatch_retry_columns', '1f63eccf69730da0ac57c992fe83cb95d406f4629c6dfeb89aca23b09ffde6c7', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (65, 'WEB', '20260408000003', 'apple_pay_cert_expiry', 'f7d87a12a254e475d87a70316ff6335469f0d0d2e051b2d879a1678c9cba2ac1', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (66, 'WEB', '20260415230000', 'product_categories_localized', '43fc2a23071a9afaa8b296d4c58748a9f29e9521cea5b094551dc6b9e3572f10', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (67, 'WEB', '20260415230100', 'foodics_sync_columns', '1a97f956d5e07f751133fec56cd19ef003c265305f4c4d57d80aaaef80f9779d', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (68, 'WEB', '20260416000000', 'promo_scope_and_price_overrides', '3c99baa0e0c78d231f30e9e91e8056fed3ddb7a2e8dca4c93df4d15e7b98a8bc', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (69, 'ALS', '20260417000000', 'expand_order_status', 'c2661660321e037118150537aa3eb6cdaba09deb3bf8dd6a577c52dbf0430811', 'REGISTERED_NAME_MATCH', 'pending_unproven', 'inventory_only'),
  (70, 'WEB', '20260417000000', 'expand_order_status', 'e0c0b2ef3555efe0d709230acfaceb40979ece72bdacc133138b5e19e741a461', 'REGISTERED_NAME_MATCH', 'pending_unproven', 'inventory_only'),
  (71, 'WEB', '20260417000001', 'foodics_webhook_tracking', 'c035ffb8e4fc29876a88dd6665b89fb34968ac558ea320ab413fff1addf1dbc3', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (72, 'ALS', '20260418000000', 'ready_at_column', '5d5474c2227b950bb709661f7e0181ad5b7de33145503f150402f813ff87355f', 'REGISTERED_NAME_MATCH', 'pending_unproven', 'inventory_only'),
  (73, 'WEB', '20260418000000', 'ready_at_column', '1b3bf8e870e4b9200cc6e0931f972c1c3f1d653de4875117248449989dc68adf', 'REGISTERED_NAME_MATCH', 'pending_unproven', 'inventory_only'),
  (74, 'ALS', '20260418000001', 'push_language', '0b9b217dc2de9ef05e68031b5bddc77b9ada4be65963e58ce4a34fbfadac2a9b', 'REGISTERED_NAME_MATCH', 'pending_unproven', 'inventory_only'),
  (75, 'WEB', '20260418000001', 'push_language', 'd310e12b8721d630ed42aceceafaef94dc44b113cb1e6c028e950a0cb351df76', 'REGISTERED_NAME_MATCH', 'pending_unproven', 'inventory_only'),
  (76, 'ALS', '20260418000002', 'driver_close_notified', '7adc048df45150acaf6d940fc7f7ff4e458c4d59ac511cfe598302ec21efdf86', 'REGISTERED_NAME_MATCH', 'pending_unproven', 'inventory_only'),
  (77, 'WEB', '20260418000002', 'driver_close_notified', '044770bedf4d6c9f170d0bfe516fb446a911031632fa020233a98c41fb8b4e1d', 'REGISTERED_NAME_MATCH', 'pending_unproven', 'inventory_only'),
  (78, 'WEB', '20260422000000', 'branch_operations_hours', 'b23872105e39f44c28e86cbd447262bbd2313fedd68390a6e0527307d6881083', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (79, 'WEB', '20260422010000', 'driver_live_location', '1af62af435207fb42943442d705497492c6d12ba8103df2d2b2a48fc86fb68f1', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (80, 'WEB', '20260422020000', 'production_hardening_schema', '3613c884304cf0fdb245bf9920525d8667026cc0955341504fe2716c9b44e264', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (81, 'WEB', '20260422030000', 'drop_redundant_payment_credentials', '5ee9be5a9bc4d4b7c4d8a29a0c38e168844fbad6808d31e4dfc45f6ca56f2335', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (82, 'WEB', '20260422040000', 'branch_delivery_fee', '311e00fdc5a476b649f54a182f0b4664dcec18ffa327ca7271f8805e5f8b79c5', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (83, 'WEB', '20260423000000', 'wallet_stamp_icon_scale', '56fec4128961a866cde69de0bc4d162118e4ba45bb84659c9da273cc92330458', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (84, 'WEB', '20260425000000', 'apple_credentials_registered', '47999245ffef71e0d057349a69858ecd62b993ce7e604f1ca9677bda6020ecfe', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (85, 'WEB', '20260426000000', 'branch_delivery_radius', 'a790dbd23a23ccf8ae04330109623fd0562c7d4885bfb6337f83dc58c04308a5', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (86, 'WEB', '20260427000000', 'customer_wallet', '93ab65d411a222759c38e429f1a6f609db1260b946c56eba0db6e0a76268d14e', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (87, 'WEB', '20260503000000', 'tester_apple_id', '9a81eba93b95871e96a7620d655c1466ff3a3ddbfa8824006d703312c9f31d01', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (88, 'WEB', '20260504000000', 'apple_pay_csr', 'f2da6d7169664b91850a15fd716a401288faa1316e43973d6dd2e102a4240995', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (89, 'WEB', '20260504010000', 'apple_pay_cer', '1f3895ef60d09d045d13038cfc9e15dd9f912e62971be5be9f7aa86a4255d3ae', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (90, 'WEB', '20260509000000', 'add_promo_discount_to_customer_orders', '2c5b5d87c03140191ce077298534887f49dd79cc1f06a70e28d5f936dc95b26f', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (91, 'WEB', '20260510000000', 'check_email_confirmed_rpc', '420af43f08fa0eda16be46b8a4fc20ebacb51f83d764ee4d82740372ac1b2325', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (92, 'WEB', '20260511000000', 'play_console_registered', '72b9834c838c1d3344e0151128f3e4109dee510eea42c862efc1040917c8b572', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (93, 'ALS', '20260512000000', 'order_payment_composition', '197c4fdaf13edd818008e36f311c7ba348befc84fa5653f6137ab771d27d1433', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (94, 'ALS', '20260512000001', 'order_reversals_audit', '0270094a496ac6e02e1e059efc8cdaa45042a3c7f52a222de7465a48e59d61d4', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (95, 'ALS', '20260512000002', 'payment_confirmed_at', '46d3aec1c57eed4c4113e912e607b894773c03c985fd6480ce8fd9689b988b1b', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (96, 'WEB', '20260513000001', 'promos_bucket', '159f1ddd5656121ed616876cb2f4b6a86701d1502f6dfdb630af622a367f4a31', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (97, 'WEB', '20260513000002', 'promo_redemptions', '9315042d0c9680e8d8f1897a6368b2b56223866c04b9d34f88ac69e87b06484e', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (98, 'WEB', '20260513000003', 'promo_per_customer_limit', 'b38fba83868a43ec07f52fdc0e069b769c8be476e290205cd3c94ad7754e6ea3', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (99, 'WEB', '20260518000001', 'adapter_per_merchant_token', '26e56763cad7ddc41daceb6af2cff6a2a7b8c2078e6d16270a84dd60fedf8d42', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (100, 'WEB', '20260518000002', 'stamp_redemption_order_id', '21c0487930f23e2f807fcf6b2b47b60811aae44b9dc7a60d8563c19cbf05ecaa', 'REGISTERED_NAME_MATCH', 'superseded_obsolete', 'superseded_terminal_state_20260715'),
  (101, 'ALS', '20260521000000', 'storage_bucket_merchant_scoping', 'b992411b74e6953382f8953e0718570bbaa4f7732ce8ffd6a15bb7108c23a321', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (102, 'WEB', '20260521000000', 'stamp_redemption_unique_unredeemed', 'd7ad98f13e0fbeb3220823eccd42eaa3ed478a1ba7c7bc91f70c42bfe8a29666', 'VERSION_OCCUPIED_BY_storage_bucket_merchant_scoping', 'superseded_obsolete', 'superseded_terminal_state_20260715'),
  (103, 'ALS', '20260521000001', 'merchant_customers_join', '895b5c2543ad283c723c40aab74e4684341e8fffc82fa6c86002452c575c95b8', 'VERSION_OCCUPIED_BY_sms_wallet_recharge_sessions', 'live_effect_attested', 'terminal_repair_20260715'),
  (104, 'WEB', '20260521000001', 'sms_wallet_recharge_sessions', '331ab80a36438d3053c3380144edbf6196960ef697e1ef26923d1f9b9e71c71d', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (105, 'ALS', '20260521000002', 'customer_merchant_profiles', '916922fb7fe02ad3cb8244e04fe3c9fa91a9981c8c02cc30c8d64fd5faec822e', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (106, 'ALS', '20260521000003', 'sms_otp_merchant_scope', '612abc061c17554b43311356ffaeac2b2a837a9c89dbb53769f7eb93f04ae4e2', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (107, 'ALS', '20260521000004', 'customer_carts', '7b7e5415eb822f0365554e6d39a766f6e6625c901b7e53aecc4d94f7baa0b68e', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (108, 'ALS', '20260522000000', 'cron_runs', 'fe3ef349e44bdf5087b12e653d70c9e381d942cc8db775307594ac0796857d92', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (109, 'ALS', '20260522000001', 'migration_status_rpc', '91b6b3dc9d4eadcb7389255c79f0655e42de5ec689b16fac94a69443c72245ed', 'REGISTERED_NAME_MATCH', 'registered_exact', 'registry_identity_match'),
  (110, 'WEB', '20260522000002', 'per_order_type_enable', 'dbceae99e41272069858d699c471ab7c54e5779e85990f5b4feddf5f7d7422b6', 'MISSING_VERSION', 'live_effect_attested', 'terminal_repair_20260715'),
  (111, 'ALS', '20260524000000', 'cart_notification_cooldown', 'd43ef9a666885358bc21d8f93db14b9aa8a5b7e91d9bf5a1869b0d4cf2a279b4', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (112, 'ALS', '20260530000000', 'phase0_cashback_nonneg', '3dd53e059a45de5b0cd8f433360aa614c74670535af04c80a49fd396a5e98195', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (113, 'WEB', '20260530000000', 'phase0_service_role_policies', '43e21fb0a379683a9728f261cd4fe08f9f508a31f2a958b441c269a268096806', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (114, 'ALS', '20260530000001', 'increment_loyalty_points_rpc', '1d1fa706dade673956c01c199da2c7a09dabd44e683535c741b06c90510302f5', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (115, 'WEB', '20260530000002', 'wallet_refund_idempotency', 'ee1d1f130db51820fa463902f99ec394bb92e3e11afb0c6b560dd5ebe7c51a69', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (116, 'WEB', '20260530000003', 'subscription_payment_id_unique', 'c959b51c61abd5d5c60e3e6d1e792184c10069d55818ec298d15bd6447b710e6', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (117, 'ALS', '20260530000004', 'loyalty_app_unique_indexes', '754c6ebded55b82fd34e85c879575df28246d790ea5cdf778c5cd56d18a9b320', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (118, 'ALS', '20260530000005', 'refund_audit_columns', '55c776057e91ce0e71495d00551fd526f92bdbcb7f6dcbc32d310588b652a6e5', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (119, 'WEB', '20260702100000', 'adjust_customer_wallet_rpc', '673044ddfea9bd89744eec5b294590b792656b55a6808b75296312e71aa8fdb8', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (120, 'WEB', '20260703000000', 'promo_order_total_scope', '133d50345ad55972916195deb21625389584dd8ab70d410b4cc5e24fa64929c7', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (121, 'WEB', '20260703100000', 'merchant_trial', '044801b98e24abd6add4fc42f217fd9063ff70996dd8c81df8bd7be20f962665', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (122, 'WEB', '20260703200000', 'walkin_sync_and_sms_price', '9abc11123935c82901c26a4a1f7192a4b90ab6d1c6cb85d798346229396a4f0f', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (123, 'WEB', '20260703300000', 'lock_down_rls_off_tables', 'ce33995eaea98471a4a87faba2353fae9ed1358fd95e434d9778864dea4a4551', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (124, 'WEB', '20260703400000', 'foodics_catalog_sync_cursor', '0a160bb119b4b4e70561913267d590066c6241238fb033b63d363820b58b9e51', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (125, 'WEB', '20260703500000', 'audit_log_action_index', 'a1b582a9993a59fb2d69692b1eb1fd333634163398ad6e2851438f8fa2df7821', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (126, 'WEB', '20260703600000', 'merchant_customer_order_stats', '7b0753dd6100180f44cc48474a35c963750a0333d7754e4a47ad98d974150552', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (127, 'WEB', '20260705000000', 'admin_finance_rollups', '4a5cc6225b90d94cf9e62397ba38e570c936ce6c3315f170d8755621e5a8471d', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (128, 'WEB', '20260705100000', 'complaints_realtime', '356f24c314de97ef6f7b87d8a741afe884886d53b72804f22feae2df2319f204', 'MISSING_VERSION', 'superseded_obsolete', 'superseded_terminal_state_20260715'),
  (129, 'ALS', '20260705200000', 'cron_locks', 'b34f921a6712bc4257631f3a5fe541347264aa3576760b6062f9227b2dfe8817', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (130, 'WEB', '20260706000000', 'realtime_publication_trim', '29e5cedb4085290f2a33d2ae85d08db26d0c9b352cfebdf5ee5cbd7a0b94bd65', 'MISSING_VERSION', 'superseded_obsolete', 'superseded_terminal_state_20260715'),
  (131, 'ALS', '20260708100000', 'phase1_close_anon_rls_leaks', '5edd3381d5a06a6878f07fef915bc5645e13f173685640c0870ca56669122e27', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (132, 'ALS', '20260708110000', 'phase2_lock_customer_orders_mutation', '40355277358aba67e7e06cfa4cbf935ab405a5af9389f421677c2b165ad5a35e', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (133, 'ALS', '20260708120000', 'phase3_money_idempotency', '24f7118eff9b06b3210edb31a7a2ce3ad2d5bf8e6945c0f150628bca045beff2', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (134, 'ALS', '20260708130000', 'phase4_revoke_ledger_write_grants', '5a466c19ce9c8387527679c2079f380def53dc1a6b4851355e14ebb7a51a9dc6', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (135, 'ALS', '20260708140000', 'phase_h8_cross_channel_earn_dedupe', '92c7259714f4573a0f23a80c94ae365b724eec27e0464510ee77f74b3175b27f', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (136, 'WEB', '20260708140000', 'phase_m11_merchant_soft_delete_guard', 'e308e559be45b47f6965eeccc9ecbe4962d7293bc41271637ef2f237e9eff3e7', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (137, 'ALS', '20260708150000', 'phase_l11_wallet_reconciliation_rpc', '83e1a318f34740b6ee346874aae9d668d76c18dc81c8894af4f3aba015634ca4', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (138, 'ALS', '20260709000000', 'master_audit_remediation', '57cb99812cc0a874958bd0c4e488678cca70e8f9b5550d11eb439d90b5d97abf', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (139, 'WEB', '20260709200000', 'branch_ops_busy_until_minute_hours', 'ba22d7a32fffc1e1a6db85495c046d74a13de40fc44cb86d8b2c5369380971e0', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (140, 'ALS', '20260710100000', 'encrypt_saved_card_tokens', '6bddfee9c98446ffb48776cbaea8d2e48bbe0819e3ff9d770e68e70ccf0e486f', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (141, 'ALS', '20260710110000', 'foodics_order_id_partial_unique', '3c55aca3cac225226f49cd610fabbf5540e117b1922bec1c83fb2dfb8e6d117f', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (142, 'WEB', '20260712030000', 'scalability_hot_indexes', 'f2be18fb83f9f4823e22135101adb966c12034f4637099ee3f1fc45eae35c71b', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (143, 'WEB', '20260712040000', 'remove_postgres_changes_fanout', 'bcc376d143e94d67a74e9ddb9c27f0c3493a52c61c95d087d2a3ac88b2e14017', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (144, 'WEB', '20260713010000', 'foodics_dispatch_queue', '3140a59719553171ea01524be895b94a7a73777bfb946ddb41b39f15e1767300', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (145, 'WEB', '20260713020000', 'saved_card_sweep_cursor', 'fc0f3110e55cc1a968c1575124b51983647a90aa512b11b6ce24930d54767d78', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (146, 'WEB', '20260713030000', 'dashboard_orders_summary_rpc', '3394d5c6c0d9d3c3a338b0b10a5cba135e8f98f31da39922a5c2dfbba87e3883', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (147, 'WEB', '20260713030100', 'dashboard_home_analytics_rpc', 'f1396531d72e4c7b55c5442fcf955bab219f9fce8cf5e3b4a206406524241d62', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (148, 'WEB', '20260713030200', 'dashboard_customer_roster_rpc', '709f8ea156399cc3f1d69a095996e276a770a4611e012c35d3413b25cf133456', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (149, 'WEB', '20260713040000', 'export_jobs', '29e9cfe1df5ba9537ae356f231a2331b94219e1f3b56ef6839c3fc747aa9c3c8', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (150, 'WEB', '20260713060000', 'push_jobs', '29e9bbdc8fae50bce55cad4a5148ee51c37f66032cf5957b896bef66d360bfdf', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (151, 'WEB', '20260713080000', 'foodics_catalog_sync_queue', 'dc7932956f3e75dfb59f778089d1c10ef5e418243413e3edaa38c1189ae8a4e2', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (152, 'WEB', '20260713090000', 'claim_export_jobs', '1b934676729c4c0cd5c717147e401663c4ed450838bc651eec851c928c9aae80', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715'),
  (153, 'ALS', '20260715000000', 'phase_a_capability_containment', '27b32dc764b83b539edb1e7958798f83f003c1c51defe08af12aae9d51c45625', 'MISSING_VERSION', 'live_effect_attested', 'terminal_effect_audit_20260715');

DO $validate_manifest_seed$
DECLARE
  actual_row_count integer;
  actual_digest text;
  status_counts integer[];
BEGIN
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            repository || '|' || migration_version || '|' || migration_name
              || '|' || source_sha256 || '|' || inventory_status,
            E'\n'
            ORDER BY inventory_ordinal
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ),
    ARRAY[
      pg_catalog.count(*) FILTER (WHERE attestation_status = 'registered_exact')::integer,
      pg_catalog.count(*) FILTER (WHERE attestation_status = 'live_effect_attested')::integer,
      pg_catalog.count(*) FILTER (WHERE attestation_status = 'superseded_obsolete')::integer,
      pg_catalog.count(*) FILTER (WHERE attestation_status = 'pending_unproven')::integer
    ]
    INTO actual_row_count, actual_digest, status_counts
    FROM pg_temp.nooks_schema_release_seed;

  IF actual_row_count <> 153 THEN
    RAISE EXCEPTION 'canonical release seed count mismatch: %', actual_row_count;
  END IF;

  IF actual_digest <> 'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493' THEN
    RAISE EXCEPTION 'canonical logical manifest digest mismatch: %', actual_digest;
  END IF;

  IF status_counts IS DISTINCT FROM ARRAY[62, 45, 4, 42] THEN
    RAISE EXCEPTION 'canonical attestation status counts mismatch: %', status_counts;
  END IF;
END
$validate_manifest_seed$;

INSERT INTO public.nooks_schema_manifests (
  manifest_sha256,
  manifest_kind,
  inventory_row_count,
  authority_repository,
  source_project_ref,
  inventory_observed_at,
  expected_registered_exact,
  expected_live_effect_attested,
  expected_superseded_obsolete,
  expected_pending_unproven
)
VALUES (
  'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493',
  'historical_inventory',
  153,
  'ALS',
  'rmslvptafkxywhpzpuxt',
  TIMESTAMPTZ '2026-07-15 01:52:49+03',
  62,
  45,
  4,
  42
)
ON CONFLICT (manifest_sha256) DO NOTHING;

INSERT INTO public.nooks_schema_releases (
  manifest_sha256,
  inventory_ordinal,
  repository,
  migration_version,
  migration_name,
  source_sha256,
  inventory_status,
  attestation_status,
  evidence_code,
  historical_inventory,
  attested_at
)
SELECT
  'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493',
  seed.inventory_ordinal,
  seed.repository,
  seed.migration_version,
  seed.migration_name,
  seed.source_sha256,
  seed.inventory_status,
  seed.attestation_status,
  seed.evidence_code,
  true,
  CASE
    WHEN seed.attestation_status = 'pending_unproven' THEN NULL
    ELSE pg_catalog.statement_timestamp()
  END
FROM pg_temp.nooks_schema_release_seed AS seed
ORDER BY seed.inventory_ordinal
ON CONFLICT (repository, migration_version, migration_name, source_sha256)
DO NOTHING;

DO $validate_durable_manifest$
DECLARE
  durable_manifest public.nooks_schema_manifests%ROWTYPE;
BEGIN
  SELECT *
    INTO durable_manifest
    FROM public.nooks_schema_manifests
   WHERE manifest_sha256 = 'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493';

  IF NOT FOUND
     OR durable_manifest.manifest_kind <> 'historical_inventory'
     OR durable_manifest.inventory_row_count <> 153
     OR durable_manifest.authority_repository <> 'ALS'
     OR durable_manifest.source_project_ref <> 'rmslvptafkxywhpzpuxt'
     OR durable_manifest.expected_registered_exact <> 62
     OR durable_manifest.expected_live_effect_attested <> 45
     OR durable_manifest.expected_superseded_obsolete <> 4
     OR durable_manifest.expected_pending_unproven <> 42 THEN
    RAISE EXCEPTION 'durable manifest metadata differs from the reviewed inventory';
  END IF;

  IF EXISTS (
    SELECT
      seed.inventory_ordinal,
      seed.repository,
      seed.migration_version,
      seed.migration_name,
      seed.source_sha256,
      seed.inventory_status,
      seed.attestation_status,
      seed.evidence_code
    FROM pg_temp.nooks_schema_release_seed AS seed
    EXCEPT
    SELECT
      release.inventory_ordinal,
      release.repository,
      release.migration_version,
      release.migration_name,
      release.source_sha256,
      release.inventory_status,
      release.attestation_status,
      release.evidence_code
    FROM public.nooks_schema_releases AS release
    WHERE release.manifest_sha256 =
      'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493'
  )
  OR EXISTS (
    SELECT
      release.inventory_ordinal,
      release.repository,
      release.migration_version,
      release.migration_name,
      release.source_sha256,
      release.inventory_status,
      release.attestation_status,
      release.evidence_code
    FROM public.nooks_schema_releases AS release
    WHERE release.manifest_sha256 =
      'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493'
    EXCEPT
    SELECT
      seed.inventory_ordinal,
      seed.repository,
      seed.migration_version,
      seed.migration_name,
      seed.source_sha256,
      seed.inventory_status,
      seed.attestation_status,
      seed.evidence_code
    FROM pg_temp.nooks_schema_release_seed AS seed
  ) THEN
    RAISE EXCEPTION 'durable release ledger differs from the reviewed inventory';
  END IF;
END
$validate_durable_manifest$;

-- Terminally repair only the four drift classes proven by the read-only audit.
CREATE INDEX IF NOT EXISTS idx_orders_branch
  ON public.orders USING btree (branch_id);

CREATE INDEX IF NOT EXISTS idx_product_categories_merchant
  ON public.product_categories USING btree (merchant_id);

COMMENT ON COLUMN public.branch_operations.delivery_enabled IS
  'Whether the branch accepts delivery orders. Independent of the legacy delivery_mode enum which is kept for back-compat reads.';
COMMENT ON COLUMN public.branch_operations.pickup_enabled IS
  'Whether the branch accepts in-store pickup orders.';
COMMENT ON COLUMN public.branch_operations.drivethru_enabled IS
  'Whether the branch accepts curbside ("Receive from your car") orders. Mapped to Foodics pickup with car details in customer_notes.';

WITH footprint AS (
  SELECT
    merchant_id::text AS merchant_id,
    customer_id::text AS customer_id,
    created_at::timestamptz AS observed_at
  FROM public.loyalty_member_profiles
  WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL

  UNION ALL

  SELECT
    merchant_id::text,
    customer_id::text,
    created_at::timestamptz
  FROM public.loyalty_points
  WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL

  UNION ALL

  SELECT
    merchant_id::text,
    customer_id::text,
    updated_at::timestamptz
  FROM public.loyalty_cashback_balances
  WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL

  UNION ALL

  SELECT
    merchant_id::text,
    customer_id::text,
    created_at::timestamptz
  FROM public.customer_orders
  WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
),
valid_pair AS (
  SELECT
    merchant.id AS merchant_id,
    footprint.customer_id,
    COALESCE(
      pg_catalog.min(footprint.observed_at),
      TIMESTAMPTZ '1970-01-01 00:00:00+00'
    ) AS enrolled_at
  FROM footprint
  JOIN public.merchants AS merchant
    ON merchant.id::text = footprint.merchant_id
  WHERE footprint.merchant_id
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND footprint.customer_id <> ''
  GROUP BY merchant.id, footprint.customer_id
)
INSERT INTO public.merchant_customers (
  merchant_id,
  customer_id,
  enrolled_via,
  enrolled_at
)
SELECT
  valid_pair.merchant_id,
  valid_pair.customer_id,
  'back_populated',
  valid_pair.enrolled_at
FROM valid_pair
ORDER BY valid_pair.merchant_id, valid_pair.customer_id
ON CONFLICT (merchant_id, customer_id) DO NOTHING;

DO $validate_terminal_repairs$
DECLARE
  expected record;
BEGIN
  FOR expected IN
    SELECT *
      FROM (VALUES
        ('public.idx_orders_branch', 'public.orders', 'branch_id'),
        (
          'public.idx_product_categories_merchant',
          'public.product_categories',
          'merchant_id'
        )
      ) AS inventory(index_name, table_name, column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_index AS index_row
        JOIN pg_catalog.pg_class AS index_class
          ON index_class.oid = index_row.indexrelid
        JOIN pg_catalog.pg_am AS access_method
          ON access_method.oid = index_class.relam
       WHERE index_row.indexrelid = pg_catalog.to_regclass(expected.index_name)
         AND index_row.indrelid = pg_catalog.to_regclass(expected.table_name)
         AND index_row.indisvalid
         AND index_row.indisready
         AND NOT index_row.indisunique
         AND index_row.indpred IS NULL
         AND index_row.indexprs IS NULL
         AND index_row.indnkeyatts = 1
         AND pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true)
             = expected.column_name
         AND access_method.amname = 'btree'
    ) THEN
      RAISE EXCEPTION 'terminal repair index is absent or divergent: %', expected.index_name;
    END IF;
  END LOOP;

  IF pg_catalog.col_description(
       pg_catalog.to_regclass('public.branch_operations'),
       (
         SELECT attribute.attnum
           FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
            pg_catalog.to_regclass('public.branch_operations')
            AND attribute.attname = 'delivery_enabled'
            AND NOT attribute.attisdropped
       )
     ) IS DISTINCT FROM
       'Whether the branch accepts delivery orders. Independent of the legacy delivery_mode enum which is kept for back-compat reads.'
  OR pg_catalog.col_description(
       pg_catalog.to_regclass('public.branch_operations'),
       (
         SELECT attribute.attnum
           FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
            pg_catalog.to_regclass('public.branch_operations')
            AND attribute.attname = 'pickup_enabled'
            AND NOT attribute.attisdropped
       )
     ) IS DISTINCT FROM
       'Whether the branch accepts in-store pickup orders.'
  OR pg_catalog.col_description(
       pg_catalog.to_regclass('public.branch_operations'),
       (
         SELECT attribute.attnum
           FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
            pg_catalog.to_regclass('public.branch_operations')
            AND attribute.attname = 'drivethru_enabled'
            AND NOT attribute.attisdropped
       )
     ) IS DISTINCT FROM
       'Whether the branch accepts curbside ("Receive from your car") orders. Mapped to Foodics pickup with car details in customer_notes.'
  THEN
    RAISE EXCEPTION 'terminal repair per-order-type comments are absent or divergent';
  END IF;

  IF EXISTS (
    WITH footprint AS (
      SELECT merchant_id::text, customer_id::text
        FROM public.loyalty_member_profiles
       WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
      UNION
      SELECT merchant_id::text, customer_id::text
        FROM public.loyalty_points
       WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
      UNION
      SELECT merchant_id::text, customer_id::text
        FROM public.loyalty_cashback_balances
       WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
      UNION
      SELECT merchant_id::text, customer_id::text
        FROM public.customer_orders
       WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
    )
    SELECT 1
      FROM footprint
      JOIN public.merchants AS merchant
        ON merchant.id::text = footprint.merchant_id
     WHERE footprint.merchant_id
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND footprint.customer_id <> ''
       AND NOT EXISTS (
         SELECT 1
           FROM public.merchant_customers AS merchant_customer
          WHERE merchant_customer.merchant_id = merchant.id
            AND merchant_customer.customer_id = footprint.customer_id
       )
  ) THEN
    RAISE EXCEPTION 'merchant_customers deterministic footprint backfill is incomplete';
  END IF;

  IF pg_catalog.to_regclass('public.loyalty_stamp_redemptions') IS NOT NULL THEN
    RAISE EXCEPTION 'obsolete loyalty_stamp_redemptions table must not be recreated';
  END IF;
END
$validate_terminal_repairs$;

CREATE TEMPORARY TABLE nooks_schema_effect_seed (
  effect_key text PRIMARY KEY,
  repository text NOT NULL,
  migration_version text NOT NULL,
  migration_name text NOT NULL,
  source_sha256 text NOT NULL,
  effect_status text NOT NULL,
  evidence jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO pg_temp.nooks_schema_effect_seed
  (effect_key, repository, migration_version, migration_name, source_sha256, effect_status, evidence)
VALUES
  (
    'index:public.orders:idx_orders_branch',
    'WEB',
    '20260219100000',
    'orders_branch_delivery',
    '3dc1c496347f5bbc9f9cdd7e6f89db37d84f6127da3b52e9e99283f6a8d24c9b',
    'repaired_present',
    '{"proof":"valid nonunique btree on public.orders(branch_id)"}'::jsonb
  ),
  (
    'index:public.product_categories:idx_product_categories_merchant',
    'WEB',
    '20260222200001',
    'product_categories',
    '3bccd45c60a8d2815c14c71ad10e89c85fdf6da8526daba20d98a8a4dede8cd8',
    'repaired_present',
    '{"proof":"valid nonunique btree on public.product_categories(merchant_id)"}'::jsonb
  ),
  (
    'comments:public.branch_operations:per_order_type_enable',
    'WEB',
    '20260522000002',
    'per_order_type_enable',
    'dbceae99e41272069858d699c471ab7c54e5779e85990f5b4feddf5f7d7422b6',
    'repaired_present',
    '{"columns":["delivery_enabled","pickup_enabled","drivethru_enabled"]}'::jsonb
  ),
  (
    'data:public.merchant_customers:valid_footprint_backfill',
    'ALS',
    '20260521000001',
    'merchant_customers_join',
    '895b5c2543ad283c723c40aab74e4684341e8fffc82fa6c86002452c575c95b8',
    'repaired_present',
    '{"postcondition":"zero missing valid footprint pairs","write":"insert missing pairs only"}'::jsonb
  ),
  (
    'obsolete:public.loyalty_stamp_redemptions:base_table_lineage',
    'ALS',
    '20260330000000',
    'loyalty_three_systems',
    '59a014f6c7050dff976506520312cf07a468066a035d416e1f3e622c8ff2ae43',
    'superseded_obsolete',
    '{"terminal_state":"table absent","replacement":"loyalty_transactions milestone ledger"}'::jsonb
  ),
  (
    'obsolete:public.loyalty_stamp_redemptions:order_id',
    'WEB',
    '20260518000002',
    'stamp_redemption_order_id',
    '21c0487930f23e2f807fcf6b2b47b60811aae44b9dc7a60d8563c19cbf05ecaa',
    'superseded_obsolete',
    '{"terminal_state":"parent table absent","must_recreate":false}'::jsonb
  ),
  (
    'obsolete:public.loyalty_stamp_redemptions:unredeemed_unique',
    'WEB',
    '20260521000000',
    'stamp_redemption_unique_unredeemed',
    'd7ad98f13e0fbeb3220823eccd42eaa3ed478a1ba7c7bc91f70c42bfe8a29666',
    'superseded_obsolete',
    '{"terminal_state":"parent table absent","must_recreate":false}'::jsonb
  ),
  (
    'superseded:realtime:complaints_realtime',
    'WEB',
    '20260705100000',
    'complaints_realtime',
    '356f24c314de97ef6f7b87d8a741afe884886d53b72804f22feae2df2319f204',
    'superseded_obsolete',
    '{"terminal_state":"publication fanout removed by remove_postgres_changes_fanout"}'::jsonb
  ),
  (
    'superseded:realtime:realtime_publication_trim',
    'WEB',
    '20260706000000',
    'realtime_publication_trim',
    '29e5cedb4085290f2a33d2ae85d08db26d0c9b352cfebdf5ee5cbd7a0b94bd65',
    'superseded_obsolete',
    '{"terminal_state":"publication fanout removed by remove_postgres_changes_fanout"}'::jsonb
  );

INSERT INTO public.nooks_schema_effect_attestations (
  effect_key,
  repository,
  migration_version,
  migration_name,
  source_sha256,
  effect_status,
  evidence
)
SELECT
  seed.effect_key,
  seed.repository,
  seed.migration_version,
  seed.migration_name,
  seed.source_sha256,
  seed.effect_status,
  seed.evidence
FROM pg_temp.nooks_schema_effect_seed AS seed
ORDER BY seed.effect_key
ON CONFLICT (effect_key) DO NOTHING;

DO $validate_effect_attestations$
BEGIN
  IF EXISTS (
    SELECT *
      FROM pg_temp.nooks_schema_effect_seed
    EXCEPT
    SELECT
      effect.effect_key,
      effect.repository,
      effect.migration_version,
      effect.migration_name,
      effect.source_sha256,
      effect.effect_status,
      effect.evidence
    FROM public.nooks_schema_effect_attestations AS effect
  )
  OR EXISTS (
    SELECT
      effect.effect_key,
      effect.repository,
      effect.migration_version,
      effect.migration_name,
      effect.source_sha256,
      effect.effect_status,
      effect.evidence
    FROM public.nooks_schema_effect_attestations AS effect
    WHERE effect.effect_key = ANY (ARRAY[
      'index:public.orders:idx_orders_branch',
      'index:public.product_categories:idx_product_categories_merchant',
      'comments:public.branch_operations:per_order_type_enable',
      'data:public.merchant_customers:valid_footprint_backfill',
      'obsolete:public.loyalty_stamp_redemptions:base_table_lineage',
      'obsolete:public.loyalty_stamp_redemptions:order_id',
      'obsolete:public.loyalty_stamp_redemptions:unredeemed_unique',
      'superseded:realtime:complaints_realtime',
      'superseded:realtime:realtime_publication_trim'
    ])
    EXCEPT
    SELECT * FROM pg_temp.nooks_schema_effect_seed
  ) THEN
    RAISE EXCEPTION 'durable effect attestations differ from reviewed terminal state';
  END IF;
END
$validate_effect_attestations$;

-- Final deployment files cannot safely embed this migration's own SHA-256.
-- After the 190000 migration commits, the postgres migration owner calls this
-- append-only function once with finalized ALS file hashes. The deployment
-- digest is SHA-256 over sorted lines in this exact form:
--   ALS|version|name|sha256|AUTHORITATIVE_DEPLOYMENT
-- This keeps the attestation non-self-referential while making omission of
-- Phase B/C/D or this registry migration visible in get_migration_status().
CREATE OR REPLACE FUNCTION public.attest_nooks_schema_deployment(
  p_manifest_sha256 text,
  p_releases jsonb
)
RETURNS TABLE (
  manifest_sha256 text,
  release_count integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
SET lock_timeout TO '5s'
SET statement_timeout TO '30s'
AS $function$
-- The RETURNS TABLE output column `manifest_sha256` shadows the identically
-- named column of public.nooks_schema_manifests inside the INSERT/ON CONFLICT
-- below. Resolve any ambiguous bare reference to the COLUMN; the body never
-- reads the output variable directly (the final RETURN uses p_manifest_sha256).
#variable_conflict use_column
DECLARE
  input_count integer;
  computed_sha256 text;
  durable_manifest public.nooks_schema_manifests%ROWTYPE;
BEGIN
  IF CURRENT_USER <> 'postgres' THEN
    RAISE EXCEPTION 'deployment attestation is restricted to the postgres migration owner'
      USING ERRCODE = '42501';
  END IF;

  IF p_manifest_sha256 IS NULL
     OR p_manifest_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'deployment manifest SHA-256 is malformed';
  END IF;

  IF p_releases IS NULL
     OR pg_catalog.jsonb_typeof(p_releases) <> 'array'
     OR pg_catalog.jsonb_array_length(p_releases) = 0 THEN
    RAISE EXCEPTION 'deployment releases must be a non-empty JSON array';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('nooks:shared-schema-registry:v1', 0)
  );

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_to_recordset(p_releases)
        AS item(version text, name text, sha256 text)
     WHERE item.version IS NULL
        OR item.version !~ '^[0-9]{14}$'
        OR item.version <= '20260715000000'
        OR item.name IS NULL
        OR item.name !~ '^[a-z0-9_]+$'
        OR item.sha256 IS NULL
        OR item.sha256 !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION
      'deployment releases require post-Phase-A versions, canonical names, and SHA-256 hashes';
  END IF;

  WITH parsed AS (
    SELECT item.version, item.name, item.sha256
      FROM pg_catalog.jsonb_to_recordset(p_releases)
        AS item(version text, name text, sha256 text)
  )
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            'ALS|' || parsed.version || '|' || parsed.name || '|'
              || parsed.sha256 || '|AUTHORITATIVE_DEPLOYMENT',
            E'\n'
            ORDER BY parsed.version, parsed.name, parsed.sha256
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    INTO input_count, computed_sha256
    FROM parsed;

  IF computed_sha256 <> p_manifest_sha256 THEN
    RAISE EXCEPTION
      'deployment manifest digest mismatch: expected %, computed %',
      p_manifest_sha256,
      computed_sha256;
  END IF;

  IF input_count <> (
       SELECT pg_catalog.count(DISTINCT item.version)::integer
         FROM pg_catalog.jsonb_to_recordset(p_releases)
           AS item(version text, name text, sha256 text)
     ) THEN
    RAISE EXCEPTION 'ALS authority forbids duplicate versions in a deployment manifest';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_to_recordset(p_releases)
        AS item(version text, name text, sha256 text)
      JOIN public.nooks_schema_releases AS existing
        ON existing.repository = 'ALS'
       AND existing.migration_version = item.version
     WHERE existing.migration_name <> item.name
        OR existing.source_sha256 <> item.sha256
  ) THEN
    RAISE EXCEPTION
      'an ALS deployment version is already attested with a different name or hash';
  END IF;

  INSERT INTO public.nooks_schema_manifests (
    manifest_sha256,
    manifest_kind,
    inventory_row_count,
    authority_repository,
    source_project_ref,
    inventory_observed_at,
    expected_registered_exact,
    expected_live_effect_attested,
    expected_superseded_obsolete,
    expected_pending_unproven
  )
  VALUES (
    p_manifest_sha256,
    'deployment',
    input_count,
    'ALS',
    'rmslvptafkxywhpzpuxt',
    pg_catalog.statement_timestamp(),
    0,
    input_count,
    0,
    0
  )
  ON CONFLICT (manifest_sha256) DO NOTHING;

  SELECT *
    INTO durable_manifest
    FROM public.nooks_schema_manifests AS manifest
   WHERE manifest.manifest_sha256 = p_manifest_sha256;

  IF NOT FOUND
     OR durable_manifest.manifest_kind <> 'deployment'
     OR durable_manifest.inventory_row_count <> input_count
     OR durable_manifest.authority_repository <> 'ALS'
     OR durable_manifest.source_project_ref <> 'rmslvptafkxywhpzpuxt'
     OR durable_manifest.expected_registered_exact <> 0
     OR durable_manifest.expected_live_effect_attested <> input_count
     OR durable_manifest.expected_superseded_obsolete <> 0
     OR durable_manifest.expected_pending_unproven <> 0 THEN
    RAISE EXCEPTION 'durable deployment manifest metadata conflicts with the attestation';
  END IF;

  INSERT INTO public.nooks_schema_releases (
    manifest_sha256,
    inventory_ordinal,
    repository,
    migration_version,
    migration_name,
    source_sha256,
    inventory_status,
    attestation_status,
    evidence_code,
    historical_inventory,
    attested_at
  )
  SELECT
    p_manifest_sha256,
    pg_catalog.row_number() OVER (
      ORDER BY item.version, item.name, item.sha256
    )::integer,
    'ALS',
    item.version,
    item.name,
    item.sha256,
    'AUTHORITATIVE_DEPLOYMENT',
    'live_effect_attested',
    'authoritative_deployment_attestation',
    false,
    pg_catalog.statement_timestamp()
  FROM pg_catalog.jsonb_to_recordset(p_releases)
    AS item(version text, name text, sha256 text)
  ORDER BY item.version, item.name, item.sha256
  ON CONFLICT (repository, migration_version, migration_name, source_sha256)
  DO NOTHING;

  IF (
    SELECT pg_catalog.count(*)::integer
      FROM public.nooks_schema_releases AS release
     WHERE release.manifest_sha256 = p_manifest_sha256
  ) <> input_count
  OR EXISTS (
    SELECT item.version, item.name, item.sha256
      FROM pg_catalog.jsonb_to_recordset(p_releases)
        AS item(version text, name text, sha256 text)
    EXCEPT
    SELECT
      release.migration_version,
      release.migration_name,
      release.source_sha256
    FROM public.nooks_schema_releases AS release
    WHERE release.manifest_sha256 = p_manifest_sha256
      AND release.repository = 'ALS'
      AND release.inventory_status = 'AUTHORITATIVE_DEPLOYMENT'
      AND release.attestation_status = 'live_effect_attested'
      AND release.evidence_code = 'authoritative_deployment_attestation'
  ) THEN
    RAISE EXCEPTION 'durable deployment release rows conflict with the attestation';
  END IF;

  RETURN QUERY SELECT p_manifest_sha256, input_count;
END
$function$;

COMMENT ON FUNCTION public.attest_nooks_schema_deployment(text, jsonb) IS
  'Postgres-only append of a finalized ALS deployment delta manifest; call after the represented migrations commit.';

REVOKE ALL ON FUNCTION public.attest_nooks_schema_deployment(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_migration_status();

CREATE FUNCTION public.get_migration_status()
RETURNS TABLE (
  latest_version text,
  latest_name text,
  total_applied bigint,
  manifest_sha256 text,
  authority_repository text,
  total_inventory bigint,
  registered_exact bigint,
  live_effect_attested bigint,
  superseded_obsolete bigint,
  pending_unproven bigint,
  manifest_complete boolean,
  hashes_valid boolean,
  manifest_count bigint,
  authoritative_manifest_sha256 text,
  authoritative_release_count bigint,
  deployment_attestation_complete boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  WITH per_manifest AS (
    SELECT
      manifest.manifest_sha256,
      manifest.manifest_kind,
      manifest.inventory_row_count,
      manifest.authority_repository,
      manifest.expected_registered_exact,
      manifest.expected_live_effect_attested,
      manifest.expected_superseded_obsolete,
      manifest.expected_pending_unproven,
      pg_catalog.count(release.inventory_ordinal)::bigint AS release_count,
      pg_catalog.count(DISTINCT release.inventory_ordinal)::bigint
        AS distinct_ordinals,
      pg_catalog.min(release.inventory_ordinal) AS min_ordinal,
      pg_catalog.max(release.inventory_ordinal) AS max_ordinal,
      pg_catalog.count(*) FILTER (
        WHERE release.attestation_status = 'registered_exact'
      )::bigint AS registered_exact,
      pg_catalog.count(*) FILTER (
        WHERE release.attestation_status = 'live_effect_attested'
      )::bigint AS live_effect_attested,
      pg_catalog.count(*) FILTER (
        WHERE release.attestation_status = 'superseded_obsolete'
      )::bigint AS superseded_obsolete,
      pg_catalog.count(*) FILTER (
        WHERE release.attestation_status = 'pending_unproven'
      )::bigint AS pending_unproven,
      pg_catalog.count(*) FILTER (
        WHERE release.source_sha256 !~ '^[0-9a-f]{64}$'
      )::bigint AS invalid_hashes,
      pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(
            pg_catalog.string_agg(
              release.repository || '|' || release.migration_version || '|'
                || release.migration_name || '|' || release.source_sha256
                || '|' || release.inventory_status,
              E'\n'
              ORDER BY release.inventory_ordinal
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) AS computed_sha256
    FROM public.nooks_schema_manifests AS manifest
    LEFT JOIN public.nooks_schema_releases AS release
      ON release.manifest_sha256 = manifest.manifest_sha256
    GROUP BY
      manifest.manifest_sha256,
      manifest.manifest_kind,
      manifest.inventory_row_count,
      manifest.authority_repository,
      manifest.expected_registered_exact,
      manifest.expected_live_effect_attested,
      manifest.expected_superseded_obsolete,
      manifest.expected_pending_unproven
  ),
  rollup AS (
    SELECT
      pg_catalog.count(*)::bigint AS manifest_count,
      COALESCE(pg_catalog.sum(release_count), 0)::bigint AS total_inventory,
      COALESCE(pg_catalog.sum(registered_exact), 0)::bigint AS registered_exact,
      COALESCE(pg_catalog.sum(live_effect_attested), 0)::bigint
        AS live_effect_attested,
      COALESCE(pg_catalog.sum(superseded_obsolete), 0)::bigint
        AS superseded_obsolete,
      COALESCE(pg_catalog.sum(pending_unproven), 0)::bigint
        AS pending_unproven,
      COALESCE(
        pg_catalog.bool_and(
          release_count = inventory_row_count
          AND distinct_ordinals = inventory_row_count
          AND min_ordinal = 1
          AND max_ordinal = inventory_row_count
          AND registered_exact = expected_registered_exact
          AND live_effect_attested = expected_live_effect_attested
          AND superseded_obsolete = expected_superseded_obsolete
          AND pending_unproven = expected_pending_unproven
        ),
        false
      ) AS manifest_complete,
      COALESCE(
        pg_catalog.bool_and(
          invalid_hashes = 0
          AND computed_sha256 = manifest_sha256
        ),
        false
      ) AS hashes_valid
    FROM per_manifest
  ),
  baseline AS (
    SELECT manifest.manifest_sha256, manifest.authority_repository
      FROM public.nooks_schema_manifests AS manifest
     WHERE manifest.manifest_sha256 =
       'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493'
       AND manifest.manifest_kind = 'historical_inventory'
  ),
  deployment AS (
    SELECT
      manifest.manifest_sha256,
      pg_catalog.count(*)::bigint AS release_count
    FROM public.nooks_schema_manifests AS manifest
    JOIN public.nooks_schema_releases AS release
      ON release.manifest_sha256 = manifest.manifest_sha256
    WHERE manifest.manifest_kind = 'deployment'
      AND manifest.inventory_row_count = 4
      AND release.repository = 'ALS'
      AND release.inventory_status = 'AUTHORITATIVE_DEPLOYMENT'
      AND release.attestation_status = 'live_effect_attested'
      AND release.evidence_code = 'authoritative_deployment_attestation'
    GROUP BY manifest.manifest_sha256
    HAVING pg_catalog.count(*) = 4
       AND pg_catalog.count(*) FILTER (
         WHERE release.migration_version = ANY (ARRAY[
           '20260715160000',
           '20260715170000',
           '20260715180000',
           '20260715190000'
         ])
       ) = 4
    ORDER BY manifest.manifest_sha256
    LIMIT 1
  )
  SELECT
    (
      SELECT migration.version
        FROM supabase_migrations.schema_migrations AS migration
       ORDER BY migration.version DESC
       LIMIT 1
    ) AS latest_version,
    (
      SELECT migration.name
        FROM supabase_migrations.schema_migrations AS migration
       ORDER BY migration.version DESC
       LIMIT 1
    ) AS latest_name,
    (
      SELECT pg_catalog.count(*)
        FROM supabase_migrations.schema_migrations
    ) AS total_applied,
    baseline.manifest_sha256,
    baseline.authority_repository,
    rollup.total_inventory,
    rollup.registered_exact,
    rollup.live_effect_attested,
    rollup.superseded_obsolete,
    rollup.pending_unproven,
    (
      rollup.manifest_complete
      AND baseline.manifest_sha256 IS NOT NULL
    ) AS manifest_complete,
    rollup.hashes_valid,
    rollup.manifest_count,
    deployment.manifest_sha256 AS authoritative_manifest_sha256,
    COALESCE(deployment.release_count, 0)::bigint
      AS authoritative_release_count,
    (deployment.manifest_sha256 IS NOT NULL)
      AS deployment_attestation_complete
  FROM rollup
  LEFT JOIN baseline ON true
  LEFT JOIN deployment ON true;
$function$;

REVOKE ALL ON FUNCTION public.get_migration_status()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_migration_status()
  TO service_role;

RESET lock_timeout;
RESET statement_timeout;
