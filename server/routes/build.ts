/**
 * Nooks build webhook – Option A (one build per merchant).
 * Receives POST from Nooks after merchant payment and triggers the GitHub Actions
 * workflow that runs EAS build for Android + iOS with merchant branding env vars.
 */
import { Router, Request, Response } from 'express';
import { requireDiagnosticAccess } from '../utils/nooksInternal';

const BUILD_WEBHOOK_BASE_URL = process.env.BUILD_WEBHOOK_BASE_URL || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export const buildRouter = Router();

buildRouter.get('/', (req: Request, res: Response) => {
  if (!requireDiagnosticAccess(req, res)) return;
  const base = BUILD_WEBHOOK_BASE_URL || (req.get('host') ? `${req.protocol}://${req.get('host')}` : '');
  const normalizedBase = base.replace(/\/$/, '');
  const webhook_url = normalizedBase
    ? (normalizedBase.endsWith('/build') ? normalizedBase : `${normalizedBase}/build`)
    : null;
  const token = process.env.GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_REPO || '';
  const configured = !!(token && repo);
  return res.json({
    webhook_url,
    configured,
    token_length: token.length,
    repo,
    message: configured
      ? (webhook_url ? `Give Nooks this URL: ${webhook_url}` : 'Set BUILD_WEBHOOK_BASE_URL for the public webhook URL.')
      : 'Set GITHUB_TOKEN and GITHUB_REPO in server env to enable build trigger.',
  });
});

/** GET /build/test – diagnostic: tries to dispatch a no-op and returns the GitHub API response */
buildRouter.get('/test', async (req: Request, res: Response) => {
  if (!requireDiagnosticAccess(req, res)) return;
  const token = process.env.GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_REPO || '';
  const ref = process.env.GITHUB_BUILD_REF || 'master';

  if (!token || !repo) {
    return res.json({ error: 'GITHUB_TOKEN or GITHUB_REPO not set', token_length: token.length, repo });
  }

  try {
    const url = `https://api.github.com/repos/${repo}/actions/workflows/nooks-build.yml/dispatches`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref,
        inputs: { merchant_id: 'diagnostic-test' },
      }),
    });

    const text = await response.text().catch(() => '');
    return res.json({
      github_status: response.status,
      github_ok: response.ok,
      github_body: text || '(empty - 204 means success)',
      token_prefix: token.substring(0, 10) + '...',
      repo,
      ref,
    });
  } catch (err: any) {
    return res.json({
      error: 'fetch threw',
      message: err.message,
      name: err.name,
      cause: err.cause?.message || err.cause?.code || String(err.cause || 'none'),
      token_prefix: token.substring(0, 10) + '...',
    });
  }
});

buildRouter.get('/ping-github', async (_req: Request, res: Response) => {
  if (!requireDiagnosticAccess(_req, res)) return;
  try {
    const r = await fetch('https://api.github.com/zen');
    const text = await r.text();
    return res.json({ ok: true, status: r.status, body: text });
  } catch (err: any) {
    return res.json({ ok: false, error: err.message, cause: err.cause?.message || err.cause?.code || String(err.cause || 'none') });
  }
});

buildRouter.post('/', async (req: Request, res: Response) => {
  const BUILD_SECRET = process.env.BUILD_WEBHOOK_SECRET || '';
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
  const GITHUB_REPO = process.env.GITHUB_REPO || '';
  const GITHUB_REF = process.env.GITHUB_BUILD_REF || 'master';

  if (!BUILD_SECRET && IS_PRODUCTION) {
    return res.status(503).json({ error: 'Build webhook secret is not configured' });
  }

  if (BUILD_SECRET && req.headers['x-nooks-secret'] !== BUILD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    merchant_id,
    app_name,
    app_icon_url,
    app_icon_bg_color,
    launcher_icon_scale,
    logo_url,
    primary_color,
    accent_color,
    background_color,
    menu_card_color,
    text_color,
    tab_text_color,
    ios_bundle_id,
    android_package_id,
    apple_pay_merchant_id,
    moyasar_publishable_key,
    use_test_builds,
  } = req.body || {};
  if (!merchant_id || typeof merchant_id !== 'string') {
    return res.status(400).json({ error: 'Missing merchant_id' });
  }

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.warn('[Build] GITHUB_TOKEN or GITHUB_REPO not set');
    return res.status(500).json({
      error: 'Server not configured for build trigger. Set GITHUB_TOKEN and GITHUB_REPO.',
    });
  }

  const inputs: Record<string, string> = {
    merchant_id: String(merchant_id).trim(),
    app_name: app_name != null ? String(app_name) : 'Nooks App',
    app_icon_url: app_icon_url != null ? String(app_icon_url) : '',
    app_icon_bg_color: app_icon_bg_color != null ? String(app_icon_bg_color) : '',
    launcher_icon_scale:
      launcher_icon_scale != null && launcher_icon_scale !== ''
        ? String(launcher_icon_scale)
        : '70',
    logo_url: logo_url != null ? String(logo_url) : '',
    primary_color: primary_color != null ? String(primary_color) : '#0D9488',
    accent_color: accent_color != null ? String(accent_color) : '#0D9488',
    background_color: background_color != null ? String(background_color) : '#f5f5f4',
    menu_card_color: menu_card_color != null ? String(menu_card_color) : '#f5f5f4',
    text_color: text_color != null ? String(text_color) : '#1f2937',
    tab_text_color: tab_text_color != null ? String(tab_text_color) : '#ffffff',
    ios_bundle_id: ios_bundle_id != null ? String(ios_bundle_id) : '',
    android_package_id: android_package_id != null ? String(android_package_id) : '',
    apple_pay_merchant_id: apple_pay_merchant_id != null ? String(apple_pay_merchant_id) : '',
    moyasar_publishable_key: moyasar_publishable_key != null ? String(moyasar_publishable_key) : '',
  };
  const useTestBuilds = !(use_test_builds === false || use_test_builds === 'false');
  if (useTestBuilds) {
    inputs.use_test_builds = 'true';
  }

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/nooks-build.yml/dispatches`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: GITHUB_REF,
        inputs,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[Build] GitHub trigger failed:', response.status, text);
      return res.status(502).json({
        error: 'GitHub API rejected the dispatch',
        github_status: response.status,
        github_body: text,
      });
    }

    console.log('[Build] Triggered workflow for merchant:', inputs.merchant_id);
    return res.json({ success: true, merchant_id: inputs.merchant_id, github_status: response.status });
  } catch (err: any) {
    console.error('[Build] Error triggering workflow:', err.message);
    return res.status(500).json({
      error: 'Failed to call GitHub API',
      message: err.message,
    });
  }
});
