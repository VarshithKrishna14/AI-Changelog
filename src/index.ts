import 'dotenv/config';
import { setupCorsair } from 'corsair/setup';
import { createServer } from './server.js';
import { corsair, writeMode } from './corsair.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  // Seed plugin credentials into the DB so Corsair's key builders can find them.
  // When a database is connected to createCorsair, Corsair switches to DB-backed
  // credential storage. setupCorsair writes the tokens into corsair_integrations /
  // corsair_accounts so every subsequent API call (commits, Slack, Notion) works.
  await setupCorsair(corsair, {
    credentials: {
      github: { api_key: process.env.GITHUB_TOKEN ?? process.env.GITHUB_API_KEY ?? '' },
      slack:  { api_key: process.env.SLACK_BOT_TOKEN ?? process.env.SLACK_KEY ?? '' },
      notion: { api_key: process.env.NOTION_API_KEY ?? process.env.NOTION_KEY ?? '' },
    },
  });

  console.log('[setup] ✅ Credentials seeded into DB');

  const app = createServer();

  app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════╗
  ║       AI Changelog Narrator              ║
  ║  Tag a release. Your AI tells the world. ║
  ╚══════════════════════════════════════════╝

  Listening on  http://localhost:${PORT}
  Webhook URL   http://localhost:${PORT}/webhook
  Health check  http://localhost:${PORT}/health
  Pending       http://localhost:${PORT}/pending

  Permission mode: ${writeMode === 'strict' ? '🔒 strict (writes require /approve/:token)' : '🟢 open (writes execute immediately)'}
  ${writeMode === 'strict' ? 'Approve: GET /approve/:token   Deny: GET /deny/:token' : 'Set REQUIRE_APPROVAL=true to enable the approval gate.'}

  Waiting for GitHub release.published events...
  `);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
