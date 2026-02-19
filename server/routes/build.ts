/**
 * Nooks build webhook – Option B (Serverless + GitHub Actions).
 * Receives POST from Nooks after merchant payment and triggers the GitHub Actions
 * workflow that runs EAS build for Android + iOS with merchant branding env vars.
 */
import { Router, Request, Response } from 'express';

const BUILD_SECRET = process.env.BUILD_WEBHOOK_SECRET || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // e.g. "owner/ALS_draft0"
const GITHUB_REF = process.env.GITHUB_BUILD_REF || 'main';
const BUILD_WEBHOOK_BASE_URL = process.env.BUILD_WEBHOOK_BASE_URL || ''; // e.g. https://api.als.delivery

export const buildRouter = Router();

/** GET /build – returns webhook URL for Nooks and whether server is configured (no secrets in response). */
buildRouter.get('/', (req: Request, res: Response) => {
  const base = BUILD_WEBHOOK_BASE_URL || (req.get('host') ? `${req.protocol}://${req.get('host')}` : '');
  const webhook_url = base ? `${base.replace(/\/$/, '')}/build` : null;
  const configured = !!(GITHUB_TOKEN && GITHUB_REPO);
  return res.json({
    webhook_url,
    configured,
    message: configured
      ? (webhook_url ? `Give Nooks this URL: ${webhook_url}` : 'Set BUILD_WEBHOOK_BASE_URL for the public webhook URL.')
      : 'Set GITHUB_TOKEN and GITHUB_REPO in server env to enable build trigger.',
  });
});

buildRouter.post('/', async (req: Request, res: Response) => {
  if (BUILD_SECRET && req.headers['x-nooks-secret'] !== BUILD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { merchant_id, logo_url, primary_color, accent_color } = req.body || {};
  if (!merchant_id || typeof merchant_id !== 'string') {
    return res.status(400).json({ error: 'Missing merchant_id' });
  }

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.warn('[Build] GITHUB_TOKEN or GITHUB_REPO not set');
    return res.status(500).json({
      error: 'Server not configured for build trigger. Set GITHUB_TOKEN and GITHUB_REPO.',
    });
  }

  const inputs = {
    merchant_id: String(merchant_id).trim(),
    logo_url: logo_url != null ? String(logo_url) : '',
    primary_color: primary_color != null ? String(primary_color) : '#0D9488',
    accent_color: accent_color != null ? String(accent_color) : '#0D9488',
  };

  res.status(202).json({ message: 'Builds triggered', merchant_id: inputs.merchant_id });

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
    } else {
      console.log('[Build] Triggered workflow for merchant:', inputs.merchant_id);
    }
  } catch (err) {
    console.error('[Build] Error triggering workflow:', (err as Error).message);
  }
});
