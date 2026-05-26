import 'dotenv/config';
import { createServer } from './server.js';
import { writeMode } from './corsair.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
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
