import crypto from 'crypto';
import { Client } from 'pg';
import {
  isCorrectNooksMoyasarWebhook,
  isLegacyRailwayRootWebhook,
  MoyasarWebhook,
  NOOKS_MOYASAR_WEBHOOK_URL,
  REQUIRED_MOYASAR_PAYMENT_EVENTS,
} from '../utils/moyasarWebhookConfiguration';
import { sha256 } from '../utils/paymentProcessingReconciliation';

const PROJECT_REF = 'rmslvptafkxywhpzpuxt';
const APPLY = process.argv.includes('--apply');
const EXPECTED_MERCHANT_COUNTS = new Map([
  ['b48389544bee', 19],
  ['7177f953a3b5', 1],
]);

type PaymentSettings = {
  merchant_id: string;
  environment: string | null;
  live_publishable_key_enc: string | null;
  live_secret_key_enc: string | null;
  live_webhook_secret_enc: string | null;
  test_publishable_key_enc: string | null;
  test_secret_key_enc: string | null;
  test_webhook_secret_enc: string | null;
};

type TargetMerchant = {
  merchantId: string;
  merchantHash: string;
  sandboxOrderCount: number;
  settings: PaymentSettings;
  providerSecret: string;
  webhookSecret: string;
  webhookSecretEncrypted: string;
};

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
    application_name: 'codex-moyasar-webhook-config-20260715',
    connectionTimeoutMillis: 15_000,
    query_timeout: 30_000,
  });
}

function credentialKey(): Buffer {
  return crypto.createHash('sha256').update(requiredEnv('MERCH_ENC_KEY')).digest();
}

function decryptV1(envelope: string, key: Buffer): string {
  const parts = envelope.trim().split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('expected a v1 merchant credential envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(parts[3], 'base64url')),
    decipher.final(),
  ]).toString('utf8').trim();
  if (!clear) throw new Error('merchant credential decrypted to an empty value');
  return clear;
}

function encryptV1(clear: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(clear, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function basicAuth(secret: string): string {
  return `Basic ${Buffer.from(`${secret}:`).toString('base64')}`;
}

async function providerJson(
  secret: string,
  pathname: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://api.moyasar.com/v1${pathname}`, {
      ...init,
      headers: {
        Authorization: basicAuth(secret),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function listWebhooks(secret: string): Promise<MoyasarWebhook[]> {
  const { response, body } = await providerJson(secret, '/webhooks');
  if (!response.ok) throw new Error(`Moyasar list webhooks returned HTTP ${response.status}`);
  const rows = Array.isArray(body?.webhooks) ? body.webhooks : [];
  return rows as MoyasarWebhook[];
}

async function assertAvailableEvents(secret: string): Promise<void> {
  const { response, body } = await providerJson(secret, '/webhooks/available_events');
  if (!response.ok) throw new Error(`Moyasar available events returned HTTP ${response.status}`);
  const events = new Set(Array.isArray(body?.events) ? body.events : []);
  for (const event of REQUIRED_MOYASAR_PAYMENT_EVENTS) {
    if (!events.has(event)) throw new Error(`Moyasar account does not advertise required event ${event}`);
  }
}

async function createWebhook(secret: string, sharedSecret: string): Promise<MoyasarWebhook> {
  const { response, body } = await providerJson(secret, '/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      http_method: 'post',
      url: NOOKS_MOYASAR_WEBHOOK_URL,
      shared_secret: sharedSecret,
      events: [...REQUIRED_MOYASAR_PAYMENT_EVENTS],
    }),
  });
  if (!response.ok) throw new Error(`Moyasar create webhook returned HTTP ${response.status}`);
  if (!body?.id || !isCorrectNooksMoyasarWebhook(body)) {
    throw new Error('Moyasar create webhook response failed the exact URL/method/event assertion');
  }
  return body as MoyasarWebhook;
}

async function fetchWebhook(secret: string, webhookId: string): Promise<MoyasarWebhook> {
  const { response, body } = await providerJson(secret, `/webhooks/${encodeURIComponent(webhookId)}`);
  if (!response.ok) throw new Error(`Moyasar fetch webhook returned HTTP ${response.status}`);
  return body as MoyasarWebhook;
}

async function deleteWebhook(secret: string, webhookId: string): Promise<void> {
  const { response } = await providerJson(secret, `/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Moyasar delete webhook returned HTTP ${response.status}`);
}

async function assertNooksEndpoint(sharedSecret: string, merchantId: string): Promise<void> {
  const response = await fetch(NOOKS_MOYASAR_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: `configuration-check-${crypto.randomUUID()}`,
      type: 'configuration_check',
      secret_token: sharedSecret,
      live: false,
      data: { metadata: { merchant_id: merchantId } },
    }),
  });
  const body = await response.json().catch(() => null) as { received?: boolean; skipped?: string } | null;
  if (!response.ok || body?.received !== true || body?.skipped !== 'no payment data') {
    throw new Error(`Nooks webhook authentication check failed with HTTP ${response.status}`);
  }
}

async function loadTargets(client: Client, key: Buffer): Promise<TargetMerchant[]> {
  const countsResult = await client.query<{ merchant_id: string; sandbox_count: string }>(`
    SELECT merchant_id::text, count(*)::text AS sandbox_count
    FROM public.customer_orders
    WHERE commission_status = 'sandbox'
      AND commission_amount = 0
      AND payment_id IS NOT NULL
      AND payment_id !~ '^(wallet:|reward:)'
    GROUP BY merchant_id
  `);
  const countById = new Map(countsResult.rows.map((row) => [row.merchant_id, Number(row.sandbox_count)]));
  const candidateIds = [...countById.keys()].filter((id) => EXPECTED_MERCHANT_COUNTS.has(sha256(id).slice(0, 12)));
  if (candidateIds.length !== EXPECTED_MERCHANT_COUNTS.size) {
    throw new Error(`expected ${EXPECTED_MERCHANT_COUNTS.size} sandbox merchants, got ${candidateIds.length}`);
  }

  const settingsResult = await client.query<PaymentSettings>(`
    SELECT
      merchant_id::text,
      environment,
      live_publishable_key_enc,
      live_secret_key_enc,
      live_webhook_secret_enc,
      test_publishable_key_enc,
      test_secret_key_enc,
      test_webhook_secret_enc
    FROM public.merchant_payment_settings
    WHERE merchant_id::text = ANY($1::text[])
    ORDER BY merchant_id
  `, [candidateIds]);
  if (settingsResult.rows.length !== EXPECTED_MERCHANT_COUNTS.size) {
    throw new Error('merchant payment settings cardinality mismatch');
  }

  return settingsResult.rows.map((settings) => {
    const merchantHash = sha256(settings.merchant_id).slice(0, 12);
    const sandboxOrderCount = countById.get(settings.merchant_id) ?? 0;
    if (sandboxOrderCount !== EXPECTED_MERCHANT_COUNTS.get(merchantHash)) {
      throw new Error(`sandbox order count changed for merchant ${merchantHash}`);
    }
    const secretEnvelope = settings.test_secret_key_enc ?? settings.live_secret_key_enc;
    const publishableEnvelope = settings.test_publishable_key_enc ?? settings.live_publishable_key_enc;
    if (!secretEnvelope || !publishableEnvelope) throw new Error(`merchant ${merchantHash} is missing payment credentials`);
    const providerSecret = decryptV1(secretEnvelope, key);
    const publishable = decryptV1(publishableEnvelope, key);
    if (!providerSecret.startsWith('sk_test_') || !publishable.startsWith('pk_test_')) {
      throw new Error(`merchant ${merchantHash} is not uniformly Moyasar test-mode`);
    }

    const existingWebhookEnvelope = settings.test_webhook_secret_enc ?? settings.live_webhook_secret_enc;
    const webhookSecret = existingWebhookEnvelope
      ? decryptV1(existingWebhookEnvelope, key)
      : crypto.randomBytes(32).toString('base64url');
    return {
      merchantId: settings.merchant_id,
      merchantHash,
      sandboxOrderCount,
      settings,
      providerSecret,
      webhookSecret,
      webhookSecretEncrypted: existingWebhookEnvelope ?? encryptV1(webhookSecret, key),
    };
  });
}

async function persistSandboxConfiguration(client: Client, targets: TargetMerchant[]): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('moyasar-sandbox-webhook-config-20260715', 0))");
    const locked = await client.query<PaymentSettings>(`
      SELECT
        merchant_id::text,
        environment,
        live_publishable_key_enc,
        live_secret_key_enc,
        live_webhook_secret_enc,
        test_publishable_key_enc,
        test_secret_key_enc,
        test_webhook_secret_enc
      FROM public.merchant_payment_settings
      WHERE merchant_id::text = ANY($1::text[])
      ORDER BY merchant_id
      FOR UPDATE
    `, [targets.map((target) => target.merchantId)]);
    if (locked.rows.length !== targets.length) throw new Error('locked payment settings cardinality mismatch');

    for (const target of targets) {
      const current = locked.rows.find((row) => row.merchant_id === target.merchantId);
      if (!current) throw new Error(`locked settings missing for ${target.merchantHash}`);
      const updated = await client.query(`
        UPDATE public.merchant_payment_settings
        SET environment = 'sandbox',
            test_publishable_key_enc = coalesce(test_publishable_key_enc, live_publishable_key_enc),
            test_secret_key_enc = coalesce(test_secret_key_enc, live_secret_key_enc),
            test_webhook_secret_enc = $2,
            updated_at = clock_timestamp()
        WHERE merchant_id::text = $1
      `, [target.merchantId, target.webhookSecretEncrypted]);
      if (updated.rowCount !== 1) throw new Error(`settings update cardinality mismatch for ${target.merchantHash}`);
    }

    await client.query(
      `INSERT INTO public.audit_log (merchant_id, action, payload)
       VALUES (NULL, 'moyasar.payment_settings_reclassified_sandbox', $1::jsonb)`,
      [JSON.stringify({
        operation_id: 'moyasar-sandbox-webhook-config-20260715',
        project_ref: PROJECT_REF,
        merchant_counts: targets.map((target) => ({ merchant_hash: target.merchantHash, order_count: target.sandboxOrderCount })),
        reason: 'selected live credential slots contained sk_test_/pk_test_ keys',
      })],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function recordProviderConfiguration(
  client: Client,
  results: Array<{ merchantHash: string; webhookIdHash: string; deletedLegacy: number; deletedDuplicate: number }>,
) {
  await client.query(
    `INSERT INTO public.audit_log (merchant_id, action, payload)
     VALUES (NULL, 'moyasar.order_webhooks_configured', $1::jsonb)`,
    [JSON.stringify({
      operation_id: 'moyasar-order-webhooks-20260715',
      project_ref: PROJECT_REF,
      url: NOOKS_MOYASAR_WEBHOOK_URL,
      events: REQUIRED_MOYASAR_PAYMENT_EVENTS,
      merchants: results,
    })],
  );
}

async function main(): Promise<void> {
  if ((process.env.CONFIRM_FRANKFURT_REF ?? '').trim() !== PROJECT_REF) {
    throw new Error(`set CONFIRM_FRANKFURT_REF=${PROJECT_REF} to acknowledge the production DB target`);
  }
  const key = credentialKey();
  const client = databaseClient();
  const targets: TargetMerchant[] = [];
  try {
    await client.connect();
    const identity = await client.query<{ current_user: string; current_database: string }>('select current_user, current_database()');
    if (identity.rows[0]?.current_user !== 'postgres' || identity.rows[0]?.current_database !== 'postgres') {
      throw new Error('database identity is not the explicit Frankfurt project');
    }
    targets.push(...await loadTargets(client, key));

    const previews = [];
    for (const target of targets) {
      await assertAvailableEvents(target.providerSecret);
      const hooks = await listWebhooks(target.providerSecret);
      previews.push({
        merchant_hash: target.merchantHash,
        sandbox_orders: target.sandboxOrderCount,
        db_environment_before: target.settings.environment,
        correct_hooks_before: hooks.filter(isCorrectNooksMoyasarWebhook).length,
        legacy_root_hooks_before: hooks.filter(isLegacyRailwayRootWebhook).length,
      });
    }
    console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', project_ref: PROJECT_REF, targets: previews }, null, 2));
    if (!APPLY) return;

    await persistSandboxConfiguration(client, targets);
    const results = [];
    for (const target of targets) {
      const before = await listWebhooks(target.providerSecret);
      const created = await createWebhook(target.providerSecret, target.webhookSecret);
      const createdId = String(created.id);
      const fetched = await fetchWebhook(target.providerSecret, createdId);
      if (!isCorrectNooksMoyasarWebhook(fetched) || fetched.id !== createdId) {
        throw new Error(`created webhook read-back failed for merchant ${target.merchantHash}`);
      }
      await assertNooksEndpoint(target.webhookSecret, target.merchantId);

      let deletedLegacy = 0;
      let deletedDuplicate = 0;
      for (const hook of before) {
        if (!hook.id || hook.id === createdId) continue;
        if (isLegacyRailwayRootWebhook(hook)) {
          await deleteWebhook(target.providerSecret, hook.id);
          deletedLegacy += 1;
        } else if (isCorrectNooksMoyasarWebhook(hook)) {
          await deleteWebhook(target.providerSecret, hook.id);
          deletedDuplicate += 1;
        }
      }

      const after = await listWebhooks(target.providerSecret);
      if (after.filter(isCorrectNooksMoyasarWebhook).length !== 1 || after.some(isLegacyRailwayRootWebhook)) {
        throw new Error(`provider webhook postcondition failed for merchant ${target.merchantHash}`);
      }
      results.push({
        merchantHash: target.merchantHash,
        webhookIdHash: sha256(createdId).slice(0, 12),
        deletedLegacy,
        deletedDuplicate,
      });
    }
    await recordProviderConfiguration(client, results);
    console.log(JSON.stringify({ applied: true, url: NOOKS_MOYASAR_WEBHOOK_URL, merchants: results }, null, 2));
  } finally {
    for (const target of targets) {
      target.providerSecret = '';
      target.webhookSecret = '';
    }
    key.fill(0);
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`[moyasar-webhook-config] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
