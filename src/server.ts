import express from 'express';
import { processWebhook } from 'corsair';
import { corsair } from './corsair.js';

export function createServer() {
  const app = express();

  // Parse raw body for webhook signature verification
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        // Attach raw body buffer for signature verification
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
    try {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v ?? '']),
      );

      const result = await processWebhook(corsair, headers, req.body);

      if (result.plugin) {
        console.log(`[webhook] Handled by ${result.plugin}.${result.action ?? 'unknown'}`);
      }

      // Webhook senders (GitHub, etc.) require a 2xx response to confirm receipt.
      // Corsair's result.response is a web-API Response — we extract just the status.
      const status =
        result.response && typeof (result.response as unknown as { status?: unknown }).status === 'number'
          ? (result.response as unknown as { status: number }).status
          : 200;

      res.status(status < 200 || status > 299 ? 200 : status).json({ ok: true });
    } catch (err) {
      console.error('[webhook] Error:', err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  return app;
}
