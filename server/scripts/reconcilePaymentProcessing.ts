import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import {
  candidateSnapshotHash,
  PaymentProcessingCandidate,
  sha256,
  VerifiedPaymentEvidence,
  verifyMoyasarPayment,
} from '../utils/paymentProcessingReconciliation';

const PROJECT_REF = 'rmslvptafkxywhpzpuxt';
const EXPECTED_CANDIDATES = 20;
const EXPECTED_MERCHANTS = 2;
const EXPECTED_LEGACY_METADATA_EXCEPTIONS = 1;
const EXPECTED_MONETARY_DELTA_SAR = -8;
const REGISTRY_MANIFEST_SHA256 = 'D939264176FE1FF360C27CB2B56B83CEFC23BC5B29A3AC55FF1DFB1C6F233493';
const APPLY = process.argv.includes('--apply');

const CANDIDATE_COLUMNS = `
  o.id,
  o.merchant_id,
  o.payment_id,
  o.status,
  o.payment_method,
  o.total_sar,
  o.card_paid_sar,
  o.wallet_paid_sar,
  o.cashback_paid_sar,
  o.payment_confirmed_at,
  o.refund_status,
  o.refund_amount,
  o.refunded_at,
  o.commission_status,
  o.commission_amount,
  o.created_at,
  o.updated_at,
  m.environment,
  m.live_secret_key_enc,
  m.test_secret_key_enc
`;

const CANDIDATE_SQL = `
  SELECT ${CANDIDATE_COLUMNS}
  FROM public.customer_orders o
  JOIN public.merchant_payment_settings m ON m.merchant_id::text = o.merchant_id::text
  WHERE o.status IN ('Delivered', 'Cancelled')
    AND (o.commission_status IS NULL OR o.commission_status = 'pending')
    AND o.payment_id IS NOT NULL
    AND o.payment_id !~ '^(wallet:|reward:)'
    AND o.created_at < now() - interval '1 hour'
  ORDER BY o.created_at, o.id
`;

type SecretKeyMap = Record<string, Buffer>;

function requiredEnv(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function databaseClient(): Client {
  return new Client({
    host: 'aws-0-eu-central-1.pooler.supabase.com',
    port: 5432,
    database: 'postgres',
    user: `postgres.${PROJECT_REF}`,
    password: requiredEnv('FF_DB_PASSWORD'),
    ssl: { rejectUnauthorized: false },
    application_name: 'codex-payment-reconcile-20260715',
    connectionTimeoutMillis: 15_000,
    query_timeout: 30_000,
  });
}

function loadCredentialKeys(): SecretKeyMap {
  const keys: SecretKeyMap = {};
  const legacy = (process.env.MERCH_ENC_KEY ?? '').trim();
  if (legacy) keys.__legacy__ = crypto.createHash('sha256').update(legacy).digest();

  const rawMap = (process.env.MERCH_ENC_KEYS ?? '').trim();
  if (rawMap) {
    const parsed = JSON.parse(rawMap) as Record<string, unknown>;
    for (const [keyId, secret] of Object.entries(parsed)) {
      if (!keyId || typeof secret !== 'string' || !secret.trim()) continue;
      keys[keyId] = crypto.createHash('sha256').update(secret.trim()).digest();
    }
  }
  if (Object.keys(keys).length === 0) throw new Error('MERCH_ENC_KEY or MERCH_ENC_KEYS is required');
  return keys;
}

function decryptCredential(envelope: string, keys: SecretKeyMap): string {
  const parts = envelope.trim().split(':');
  let key: Buffer | undefined;
  let iv: string;
  let tag: string;
  let ciphertext: string;
  if (parts[0] === 'v1' && parts.length === 4) {
    key = keys.__legacy__;
    [, iv, tag, ciphertext] = parts;
  } else if (parts[0] === 'v2' && parts.length === 5) {
    key = keys[parts[1]];
    [, , iv, tag, ciphertext] = parts;
  } else {
    throw new Error('unsupported merchant credential envelope');
  }
  if (!key) throw new Error('merchant credential key is unavailable');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8').trim();
  if (!clear) throw new Error('merchant credential decrypted to an empty value');
  return clear;
}

function selectedSecretEnvelope(row: PaymentProcessingCandidate): string {
  const envelope = row.environment === 'sandbox' ? row.test_secret_key_enc : row.live_secret_key_enc;
  if (!envelope) throw new Error('merchant has no selected Moyasar secret key');
  return envelope;
}

async function fetchProviderPayment(secretKey: string, paymentId: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`https://api.moyasar.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        method: 'GET',
        headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}` },
        signal: controller.signal,
      });
      if (response.ok) return await response.json();
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Moyasar GET returned HTTP ${response.status}`);
      }
      if (attempt === 4) throw new Error(`Moyasar GET returned HTTP ${response.status}`);
      const retryAfterSeconds = Number(response.headers.get('retry-after') ?? 0);
      const retryMs = Math.min(
        30_000,
        Math.max(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 0, 1_000 * (2 ** attempt)),
      );
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('Moyasar GET retry budget exhausted');
}

async function verifyProviderBatch(
  candidates: PaymentProcessingCandidate[],
  credentialKeys: SecretKeyMap,
  merchantSecrets: Map<string, string>,
): Promise<VerifiedPaymentEvidence[]> {
  for (const row of candidates) {
    if (!merchantSecrets.has(row.merchant_id)) {
      const secret = decryptCredential(selectedSecretEnvelope(row), credentialKeys);
      // The exact population is backed by Moyasar test keys that were put in
      // the production credential slots. Test payments do not touch banking
      // networks, so these rows must be classified as non-billable sandbox
      // attempts. Abort if even one candidate is not in that same key class.
      if (!secret.startsWith('sk_test_')) {
        throw new Error('candidate set is not uniformly backed by Moyasar test credentials');
      }
      merchantSecrets.set(row.merchant_id, secret);
    }
  }

  const verified: VerifiedPaymentEvidence[] = [];
  for (const row of candidates) {
    const secret = merchantSecrets.get(row.merchant_id);
    if (!secret) throw new Error('merchant secret cache miss');
    const provider = await fetchProviderPayment(secret, row.payment_id);
    verified.push(verifyMoyasarPayment(row, provider));
    // Stay well below the provider's burst limit. This is an infrequent ops
    // repair, so predictable safety is more important than throughput.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const legacyCount = verified.filter((item) => item.legacyMetadataException).length;
  if (legacyCount !== EXPECTED_LEGACY_METADATA_EXCEPTIONS) {
    throw new Error(`expected exactly ${EXPECTED_LEGACY_METADATA_EXCEPTIONS} legacy metadata exception, got ${legacyCount}`);
  }
  return verified;
}

function assertCandidateSet(candidates: PaymentProcessingCandidate[]): void {
  if (candidates.length !== EXPECTED_CANDIDATES) {
    throw new Error(`expected ${EXPECTED_CANDIDATES} candidates, got ${candidates.length}`);
  }
  const paymentIds = new Set(candidates.map((row) => row.payment_id));
  if (paymentIds.size !== candidates.length) throw new Error('candidate payment IDs are not unique');
  const merchantIds = new Set(candidates.map((row) => row.merchant_id));
  if (merchantIds.size !== EXPECTED_MERCHANTS) {
    throw new Error(`expected ${EXPECTED_MERCHANTS} merchants, got ${merchantIds.size}`);
  }
  const monetaryDelta = candidates.reduce((sum, row) => sum - Number(row.commission_amount ?? 0), 0);
  if (monetaryDelta !== EXPECTED_MONETARY_DELTA_SAR) {
    throw new Error(`expected target monetary delta ${EXPECTED_MONETARY_DELTA_SAR}, got ${monetaryDelta}`);
  }
}

function redactedCandidate(row: PaymentProcessingCandidate) {
  const { live_secret_key_enc: _live, test_secret_key_enc: _test, ...safe } = row;
  return safe;
}

function statusCounts(verified: VerifiedPaymentEvidence[]) {
  return verified.reduce<Record<string, number>>((counts, item) => {
    counts[item.providerStatus] = (counts[item.providerStatus] ?? 0) + 1;
    return counts;
  }, {});
}

function merchantCounts(candidates: PaymentProcessingCandidate[]) {
  const counts = new Map<string, number>();
  for (const row of candidates) counts.set(row.merchant_id, (counts.get(row.merchant_id) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, count]) => ({ merchant_hash: sha256(id).slice(0, 12), count }))
    .sort((a, b) => b.count - a.count);
}

function writePreRepairSnapshot(
  candidates: PaymentProcessingCandidate[],
  verified: VerifiedPaymentEvidence[],
) {
  const snapshot = {
    operation: 'payment-processing-repair-20260715',
    project_ref: PROJECT_REF,
    captured_at: new Date().toISOString(),
    candidate_snapshot_sha256: candidateSnapshotHash(candidates),
    registry_manifest_sha256: REGISTRY_MANIFEST_SHA256,
    candidates: candidates.map(redactedCandidate),
    provider_evidence: verified,
  };
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const downloads = path.join(requiredEnv('USERPROFILE'), 'Downloads');
  const outputPath = path.join(downloads, `nooks_payment_processing_pre_repair_${stamp}.json`);
  fs.writeFileSync(outputPath, serialized, { encoding: 'utf8', flag: 'wx' });
  return { outputPath, fileSha256: sha256(serialized), snapshotSha256: snapshot.candidate_snapshot_sha256 };
}

async function assertFrankfurt(client: Client): Promise<void> {
  const result = await client.query<{ current_user: string; current_database: string }>(
    'select current_user, current_database()',
  );
  const row = result.rows[0];
  // Supavisor authenticates the project-qualified login above, then maps the
  // PostgreSQL session role to `postgres`; the project ref is therefore
  // asserted in the immutable connection username, while the server identity
  // must resolve to the expected database/role pair.
  if (row?.current_user !== 'postgres' || row?.current_database !== 'postgres') {
    throw new Error('database identity is not the explicit Frankfurt project');
  }
}

async function readGlobalUnbilledAmount(client: Client): Promise<number> {
  const result = await client.query<{ amount_sar: string }>(`
    SELECT coalesce(sum(coalesce(commission_amount, 0)), 0)::text AS amount_sar
    FROM public.customer_orders
    WHERE commission_status IS NULL OR commission_status IN ('pending', 'earned')
  `);
  return Number(result.rows[0]?.amount_sar ?? 0);
}

async function main(): Promise<void> {
  if ((process.env.CONFIRM_FRANKFURT_REF ?? '').trim() !== PROJECT_REF) {
    throw new Error(`set CONFIRM_FRANKFURT_REF=${PROJECT_REF} to acknowledge the production target`);
  }

  const credentialKeys = loadCredentialKeys();
  const merchantSecrets = new Map<string, string>();
  const client = databaseClient();
  try {
    await client.connect();
    await assertFrankfurt(client);

    await client.query('BEGIN TRANSACTION READ ONLY');
    const firstRead = await client.query<PaymentProcessingCandidate>(CANDIDATE_SQL);
    const globalUnbilledBefore = await readGlobalUnbilledAmount(client);
    await client.query('COMMIT');

    const candidates = firstRead.rows;
    assertCandidateSet(candidates);
    const firstVerified = await verifyProviderBatch(candidates, credentialKeys, merchantSecrets);
    const snapshot = writePreRepairSnapshot(candidates, firstVerified);

    console.log(JSON.stringify({
      mode: APPLY ? 'apply' : 'dry-run',
      project_ref: PROJECT_REF,
      candidates: candidates.length,
      merchants: merchantCounts(candidates),
      provider_status_counts: statusCounts(firstVerified),
      legacy_metadata_exceptions: firstVerified.filter((item) => item.legacyMetadataException).length,
      target_amount_before_sar: candidates.reduce((sum, row) => sum + Number(row.commission_amount ?? 0), 0),
      target_amount_after_sar: 0,
      target_classification: 'sandbox',
      expected_global_delta_sar: EXPECTED_MONETARY_DELTA_SAR,
      snapshot_path: snapshot.outputPath,
      snapshot_file_sha256: snapshot.fileSha256,
    }, null, 2));

    if (!APPLY) return;

    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '180s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('payment-processing-repair-20260715', 0))");

      const ids = candidates.map((row) => row.id);
      const lockedRead = await client.query<PaymentProcessingCandidate>(`
        SELECT ${CANDIDATE_COLUMNS}
        FROM public.customer_orders o
        JOIN public.merchant_payment_settings m ON m.merchant_id::text = o.merchant_id::text
        WHERE o.id::text = ANY($1::text[])
        ORDER BY o.created_at, o.id
        FOR UPDATE OF o
      `, [ids]);
      assertCandidateSet(lockedRead.rows);
      if (candidateSnapshotHash(lockedRead.rows) !== candidateSnapshotHash(candidates)) {
        throw new Error('candidate rows changed after the read-only preflight');
      }

      const finalVerified = await verifyProviderBatch(lockedRead.rows, credentialKeys, merchantSecrets);
      const updatePayload = finalVerified.map((item) => ({
        id: item.id,
        merchant_id: item.merchantId,
        payment_id: item.paymentId,
        provider_status: item.providerStatus,
        provider_amount: item.providerAmount,
      }));
      const updated = await client.query<{ updated_count: string }>(`
        WITH verified AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb) AS x(
            id text,
            merchant_id text,
            payment_id text,
            provider_status text,
            provider_amount bigint
          )
        ), updated AS (
          UPDATE public.customer_orders o
          SET commission_amount = 0,
              commission_status = 'sandbox',
              updated_at = clock_timestamp()
          FROM verified v
          WHERE o.id::text = v.id
            AND o.merchant_id::text = v.merchant_id
            AND o.payment_id = v.payment_id
            AND (o.commission_status IS NULL OR o.commission_status = 'pending')
            AND round((CASE WHEN coalesce(o.card_paid_sar, 0) > 0 THEN o.card_paid_sar ELSE o.total_sar END) * 100)::bigint = v.provider_amount
            AND CASE
              WHEN v.provider_status IN ('paid', 'captured') THEN o.status = 'Delivered'
              WHEN v.provider_status IN ('voided', 'refunded') THEN
                o.status = 'Cancelled'
                AND o.refund_status IN ('refunded', 'voided')
                AND coalesce(o.refund_amount, 0) > 0
              WHEN v.provider_status = 'failed' THEN
                o.status = 'Cancelled'
                AND o.refund_status = 'not_required'
                AND coalesce(o.refund_amount, 0) = 0
              ELSE false
            END
          RETURNING o.id
        )
        SELECT count(*)::text AS updated_count FROM updated
      `, [JSON.stringify(updatePayload)]);
      if (Number(updated.rows[0]?.updated_count ?? 0) !== EXPECTED_CANDIDATES) {
        throw new Error(`guarded update affected ${updated.rows[0]?.updated_count ?? 0} rows`);
      }

      const auditPayload = {
        operation_id: 'payment-processing-repair-20260715',
        source: 'merchant-key-moyasar-get',
        target_count: EXPECTED_CANDIDATES,
        provider_status_counts: statusCounts(finalVerified),
        merchant_counts: merchantCounts(lockedRead.rows),
        order_hashes: lockedRead.rows.map((row) => sha256(row.id).slice(0, 12)),
        payment_hashes: lockedRead.rows.map((row) => sha256(row.payment_id).slice(0, 12)),
        metadata_exception_count: finalVerified.filter((item) => item.legacyMetadataException).length,
        before: {
          pending: EXPECTED_CANDIDATES,
          null_amount: lockedRead.rows.filter((row) => row.commission_amount == null).length,
          zero_amount: lockedRead.rows.filter((row) => Number(row.commission_amount ?? 0) === 0).length,
          one_amount: lockedRead.rows.filter((row) => Number(row.commission_amount ?? 0) === 1).length,
          amount_sum_sar: lockedRead.rows.reduce((sum, row) => sum + Number(row.commission_amount ?? 0), 0),
        },
        after: { sandbox: EXPECTED_CANDIDATES, amount_sum_sar: 0 },
        pre_repair_snapshot_sha256: snapshot.fileSha256,
        candidate_snapshot_sha256: snapshot.snapshotSha256,
        registry_manifest_sha256: REGISTRY_MANIFEST_SHA256,
      };
      await client.query(
        `INSERT INTO public.audit_log (merchant_id, action, payload)
         VALUES (NULL, 'payment_processing.reclassified_sandbox', $1::jsonb)`,
        [JSON.stringify(auditPayload)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    await client.query('BEGIN TRANSACTION READ ONLY');
    const targetVerify = await client.query<{ sandbox_count: string; amount_sum_sar: string }>(`
      SELECT
        count(*) FILTER (WHERE commission_status = 'sandbox')::text AS sandbox_count,
        coalesce(sum(commission_amount), 0)::text AS amount_sum_sar
      FROM public.customer_orders
      WHERE id::text = ANY($1::text[])
    `, [candidates.map((row) => row.id)]);
    const remaining = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM (${CANDIDATE_SQL}) stuck`);
    const globalUnbilledAfter = await readGlobalUnbilledAmount(client);
    await client.query('COMMIT');

    const sandboxCount = Number(targetVerify.rows[0]?.sandbox_count ?? 0);
    const targetAmount = Number(targetVerify.rows[0]?.amount_sum_sar ?? 0);
    const remainingCount = Number(remaining.rows[0]?.count ?? 0);
    const globalDelta = globalUnbilledAfter - globalUnbilledBefore;
    if (
      sandboxCount !== EXPECTED_CANDIDATES ||
      targetAmount !== 0 ||
      remainingCount !== 0 ||
      globalDelta !== EXPECTED_MONETARY_DELTA_SAR
    ) {
      throw new Error(`postcondition failed: sandbox=${sandboxCount}, amount=${targetAmount}, remaining=${remainingCount}, delta=${globalDelta}`);
    }

    console.log(JSON.stringify({
      applied: true,
      target_sandbox: sandboxCount,
      target_amount_sar: targetAmount,
      remaining_candidates: remainingCount,
      global_unbilled_delta_sar: globalDelta,
    }, null, 2));
  } finally {
    merchantSecrets.clear();
    for (const key of Object.values(credentialKeys)) key.fill(0);
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`[payment-processing-reconcile] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
