import express from 'express';
import { processWebhook, executePermission } from 'corsair';
import { corsair } from './corsair.js';
import { corsairDb } from './db.js';
import type { GitHubRelease, GitHubRepository } from './corsair.js';
import type { PipelineInput } from './pipeline.js';

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v || undefined;
  }
  return undefined;
}

/** GitHub `release` webhook body after JSON parse — not the Corsair `WebhookResponse` from hook `after`. */
function pipelineInputFromGitHubReleaseBody(body: unknown): PipelineInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.action !== 'published') return null;
  const release = b.release;
  const repository = b.repository;
  if (!release || typeof release !== 'object' || !repository || typeof repository !== 'object') return null;
  const rel = release as Record<string, unknown>;
  const repo = repository as Record<string, unknown>;
  if (rel.draft === true) return null;
  if (typeof rel.tag_name !== 'string' || typeof repo.name !== 'string') return null;
  const owner = repo.owner;
  if (!owner || typeof owner !== 'object' || typeof (owner as Record<string, unknown>).login !== 'string') {
    return null;
  }
  const author = rel.author;
  const sender = b.sender;
  const authorLogin =
    author && typeof author === 'object' && typeof (author as Record<string, unknown>).login === 'string'
      ? (author as Record<string, unknown>).login
      : sender && typeof sender === 'object' && typeof (sender as Record<string, unknown>).login === 'string'
        ? (sender as Record<string, unknown>).login
        : 'unknown';
  const releaseForPipeline = {
    ...(release as GitHubRelease),
    author:
      author && typeof author === 'object'
        ? (author as GitHubRelease['author'])
        : { login: String(authorLogin), avatar_url: '', html_url: '' },
  };
  return {
    release: releaseForPipeline,
    repository: repository as GitHubRepository,
  };
}

export function createServer() {
  const app = express();

  // Parse raw body for webhook signature verification
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Single webhook endpoint — Corsair routes to the right plugin automatically
  app.post('/webhook', async (req, res) => {
    const ts = new Date().toISOString();
    const ghEvent = req.headers['x-github-event'];
    const ghDelivery = req.headers['x-github-delivery'];
    const body = req.body as Record<string, unknown> | undefined;

    console.log(`\n══════════════════════════════════════════`);
    console.log(`[webhook] POST /webhook  ${ts}`);
    console.log(`[webhook] x-github-event: ${ghEvent ?? '(none)'}`);
    console.log(`[webhook] x-github-delivery: ${ghDelivery ?? '(none)'}`);
    console.log(`[webhook] body.action: ${body?.action ?? '(none)'}`);
    console.log(`[webhook] body.release.tag_name: ${(body?.release as Record<string, unknown> | undefined)?.tag_name ?? '(none)'}`);
    console.log(`[webhook] body.release.draft: ${(body?.release as Record<string, unknown> | undefined)?.draft ?? '(none)'}`);

    try {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v ?? '']),
      );

      console.log(`[webhook] calling processWebhook…`);
      const result = await processWebhook(corsair, headers, req.body);
      console.log(`[webhook] processWebhook result → plugin: ${result.plugin ?? '(no match)'}, action: ${result.action ?? '(none)'}`);
      if (!result.plugin) {
        console.warn(`[webhook] ⚠️  No Corsair plugin matched — check GITHUB_TOKEN is valid and the webhook secret matches (or is blank on both sides)`);
      }

      // Corsair's GitHub plugin matcher requires x-hub-signature-256 (only present when a webhook
      // secret is configured). We run the pipeline directly from the verified body whenever GitHub
      // sends a `release` event, regardless of whether Corsair matched.
      if (String(ghEvent).toLowerCase() === 'release') {
        if (!result.plugin) {
          console.log(`[webhook] ℹ️  Corsair did not match (no webhook secret / no x-hub-signature-256) — running pipeline directly from body`);
        }
        console.log(`[webhook] GitHub release event detected — parsing body for pipeline input…`);
        const input = pipelineInputFromGitHubReleaseBody(req.body);
        if (input) {
          console.log(`[webhook] ✅ Pipeline input valid — ${input.repository.full_name ?? input.repository.name} @ ${input.release.tag_name}`);
          try {
            const { runPipeline } = await import('./pipeline.js');
            await runPipeline(input);
          } catch (err) {
            console.error('[webhook] ❌ Pipeline threw:', err);
          }
        } else {
          const action = (req.body as Record<string, unknown>)?.action;
          const draft = ((req.body as Record<string, unknown>)?.release as Record<string, unknown> | undefined)?.draft;
          console.log(`[webhook] ⚠️  skipping pipeline — action="${action}"  draft="${draft}"  (need action=published and draft != true)`);
        }
      } else if (ghEvent) {
        console.log(`[webhook] GitHub event "${ghEvent}" — not a release event, skipping pipeline`);
      }

      const status =
        result.response && typeof (result.response as unknown as { status?: unknown }).status === 'number'
          ? (result.response as unknown as { status: number }).status
          : 200;

      const finalStatus = status < 200 || status > 299 ? 200 : status;
      console.log(`[webhook] responding ${finalStatus}`);
      res.status(finalStatus).json({ ok: true });
    } catch (err) {
      console.error('[webhook] ❌ Unhandled error:', err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── Corsair Permission endpoints ────────────────────────────────────────────

  /**
   * List all permission records (pending, approved, denied, completed…).
   * Each entry includes ready-to-click approve/deny URLs.
   */
  app.get('/pending', async (_req, res) => {
    const records = await corsairDb.db
      .selectFrom('corsair_permissions')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();

    const baseUrl = req_baseUrl(_req);
    res.json({
      count: records.length,
      permissions: records.map((r) => ({
        token: r.token,
        status: r.status,
        plugin: r.plugin,
        endpoint: r.endpoint,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        approveUrl: `${baseUrl}/approve/${r.token}`,
        denyUrl: `${baseUrl}/deny/${r.token}`,
      })),
    });
  });

  /**
   * Approve a pending permission record.
   *
   * Flow:
   *  1. Look up the corsair_permissions row by token.
   *  2. Mark it 'approved' in the DB (required before executePermission will run it).
   *  3. Call executePermission(corsair, token) — Corsair replays the exact stored API call.
   */
  app.get('/approve/:token', async (req, res) => {
    const { token } = req.params;

    const record = await corsair.permissions.find_by_token(token);
    if (!record) {
      res.status(404).json({ ok: false, error: 'Permission record not found' });
      return;
    }
    if (record.status !== 'pending') {
      res.status(409).json({ ok: false, error: `Already ${record.status}` });
      return;
    }

    // Mark as approved — Corsair deliberately does not expose set_approved() because
    // approvals must happen through an out-of-band review flow (this endpoint).
    await corsairDb.db
      .updateTable('corsair_permissions')
      .set({ status: 'approved', updated_at: new Date() })
      .where('token', '=', token)
      .execute();

    console.log(`[approvals] ✅ Approved ${record.plugin}.${record.endpoint} (token: ${token})`);

    // Execute the stored API call with the exact args frozen at block time.
    const result = await executePermission(corsair, token);

    if (result.error) {
      console.error(`[approvals] ❌ executePermission failed:`, result.error);
      res.status(500).json({ ok: false, error: result.error });
      return;
    }

    console.log(`[approvals] ✅ ${result.plugin}.${result.endpoint} executed successfully`);
    res.json({
      ok: true,
      message: `${result.plugin}.${result.endpoint} executed successfully.`,
      plugin: result.plugin,
      endpoint: result.endpoint,
    });
  });

  /**
   * Deny a pending permission record — discards the stored API call without executing it.
   */
  app.get('/deny/:token', async (req, res) => {
    const { token } = req.params;

    const record = await corsair.permissions.find_by_token(token);
    if (!record) {
      res.status(404).json({ ok: false, error: 'Permission record not found' });
      return;
    }
    if (record.status !== 'pending') {
      res.status(409).json({ ok: false, error: `Already ${record.status}` });
      return;
    }

    await corsairDb.db
      .updateTable('corsair_permissions')
      .set({ status: 'denied', updated_at: new Date() })
      .where('token', '=', token)
      .execute();

    console.log(`[approvals] ❌ Denied ${record.plugin}.${record.endpoint} (token: ${token})`);
    res.json({
      ok: true,
      message: `${record.plugin}.${record.endpoint} denied and discarded.`,
    });
  });

  return app;
}

function req_baseUrl(req: express.Request): string {
  return process.env.PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`;
}
