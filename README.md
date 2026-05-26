# AI Changelog Narrator

> Tag a GitHub release. Your AI writes the changelog and tells the world.

**What it does:** When you publish a GitHub release, this agent automatically:
1. Reads the release notes and recent commits
2. Generates a human-readable changelog, Slack post, and tweet thread using OpenAI
3. Posts the announcement to Slack
4. Archives everything in a Notion page

**Built with [Corsair](https://corsair.dev)** — the integration layer for AI agents.  
**LLM:** [OpenAI](https://platform.openai.com) — `gpt-4o-mini` via the OpenAI API.  
**Permission system:** Corsair's built-in `read/write/require_approval` permission layer — GitHub is locked `readonly`, Slack and Notion writes can be gated behind a human approval step.

---

## How it works

```
You publish v1.3.0 on GitHub
       ↓
GitHub sends release.published webhook
       ↓
Pipeline: fetch commits → call OpenAI → generate content
       ↓
       ┌─────────────────────────────────────────────────┐
       │  REQUIRE_APPROVAL=false (default)               │
       │    → Slack #releases posted immediately         │
       │    → Notion archive page created immediately    │
       └─────────────────────────────────────────────────┘
       ┌─────────────────────────────────────────────────┐
       │  REQUIRE_APPROVAL=true                          │
       │    → Corsair intercepts write calls             │
       │    → Stores args in corsair_permissions (SQLite)│
       │    → Throws with a review token                 │
       │    → GET /approve/:token  executes the call     │
       │    → GET /deny/:token     discards it           │
       └─────────────────────────────────────────────────┘
All done in ~15 seconds.
```

---

## Project structure

```
src/
├── index.ts     Entry point — starts the Express server, shows permission mode at startup
├── db.ts        SQLite database — auto-creates corsair_permissions table on first run
├── corsair.ts   Corsair instance (GitHub + Slack + Notion) with permission config
├── pipeline.ts  Core pipeline:
│                  1. Fetch previous release tag
│                  2. Fetch commits since last release
│                  3. Call OpenAI (gpt-4o-mini) to generate all content
│                  4. Post to Slack + Notion (or park for approval)
└── server.ts    Express server:
                   POST /webhook           GitHub release event receiver
                   GET  /health            Liveness check
                   GET  /pending           List all pending approvals
                   GET  /approve/:token    Execute a parked API call
                   GET  /deny/:token       Discard a parked API call
```

---

## Quick start

### 1. Install dependencies

```bash
cd ai-changelog-narrator
npm install
```

### 2. Copy and fill in the environment file

```bash
cp .env.example .env
```

Open `.env` and fill in every value. Required fields:

| Variable | Where to get it |
|---|---|
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `CORSAIR_KEK` | Run `openssl rand -base64 32` and paste the output |
| `GITHUB_TOKEN` | GitHub → Settings → Developer settings → Personal access tokens (repo scope) |
| `SLACK_BOT_TOKEN` | Slack API → Your App → OAuth & Permissions → Bot User OAuth Token (`xoxb-...`) |
| `SLACK_CHANNEL` | The channel ID or name to post to, e.g. `#releases` or `C0123456789` |
| `NOTION_API_KEY` | Notion → Settings → Connections → New integration token |
| `NOTION_PARENT_PAGE_ID` | The page ID from the Notion URL: `notion.so/workspace/<PAGE_ID>` |

### 3. Share the Notion integration with your page

In Notion, open the parent page:
- Click `···` (top right) → **Connections** → find your integration and click **Connect**

### 4. Configure the GitHub webhook

In your GitHub repo → **Settings → Webhooks → Add webhook**:
- **Payload URL**: `http://localhost:3000/webhook` (or your ngrok URL for real events)
- **Content type**: `application/json`
- **Which events**: select **Releases** only
- **Secret**: leave blank for local testing

For local testing with real GitHub events, expose your server with [ngrok](https://ngrok.com):
```bash
ngrok http 3000
# Use the https://xxxx.ngrok.io/webhook URL in GitHub
```

### 5. Start the server

```bash
# Development — auto-restarts on file changes
npm run dev
```

You should see:
```
[db] SQLite database ready at .../corsair.db

  ╔══════════════════════════════════════════╗
  ║       AI Changelog Narrator              ║
  ╚══════════════════════════════════════════╝

  Listening on  http://localhost:3000
  Permission mode: 🟢 open (writes execute immediately)
```

---

## Running and testing

### Test A — fire a fake webhook (no real GitHub needed)

With the server running, paste this in a terminal:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: release" \
  -d '{
    "action": "published",
    "release": {
      "id": 1,
      "tag_name": "v1.0.0",
      "name": "First Release",
      "body": "Initial public release with core features.",
      "html_url": "https://github.com/acme/myapp/releases/tag/v1.0.0",
      "draft": false,
      "prerelease": false,
      "published_at": "2026-05-22T07:00:00Z",
      "created_at": "2026-05-22T07:00:00Z",
      "author": { "login": "yourname", "avatar_url": "", "html_url": "" }
    },
    "repository": {
      "id": 1,
      "name": "myapp",
      "full_name": "acme/myapp",
      "html_url": "https://github.com/acme/myapp",
      "description": "My awesome app",
      "owner": { "login": "acme" }
    }
  }'
```

Watch the server terminal — you will see the pipeline steps live. The Slack message and Notion page appear within ~15 seconds.

### Test B — human approval gate

1. Set `REQUIRE_APPROVAL=true` in `.env` and restart the server.
2. Fire the same curl above.
3. The terminal shows:
   ```
   [pipeline] ⏸  Slack blocked — Corsair requires approval.
   [pipeline]    Approve: http://localhost:3000/approve/a3f9...
   [pipeline]    Deny:    http://localhost:3000/deny/a3f9...

   [pipeline] ⏸  Notion blocked — Corsair requires approval.
   [pipeline]    Approve: http://localhost:3000/approve/d7c2...
   ```
4. Open `http://localhost:3000/pending` in a browser to see all pending requests.
5. Approve the Slack post:
   ```bash
   curl http://localhost:3000/approve/<slack-token>
   ```
   The Slack message is posted immediately.
6. Deny the Notion page:
   ```bash
   curl http://localhost:3000/deny/<notion-token>
   ```
   No Notion page is created.

### Test C — real GitHub release

1. Push a commit to a repo you own.
2. On GitHub, go to **Releases → Draft a new release**.
3. Pick a tag (e.g. `v0.1.0`), write a title and description, click **Publish release**.
4. GitHub hits your webhook URL → pipeline runs → Slack + Notion update.

---

## Corsair permission system explained

| Plugin | Mode | read | write | destructive |
|--------|------|------|-------|-------------|
| GitHub | `readonly` | allow | **deny** | deny |
| Slack | `open` (default) | allow | allow | allow |
| Slack | `strict` (REQUIRE_APPROVAL=true) | allow | **require_approval** | deny |
| Notion | `open` (default) | allow | allow | allow |
| Notion | `strict` (REQUIRE_APPROVAL=true) | allow | **require_approval** | deny |

When a call is blocked (`require_approval`):
1. Corsair serializes the full API args (channel, text, blocks, etc.) to JSON
2. Stores a row in `corsair_permissions` table in `corsair.db`
3. Throws an error with the approval token embedded in the message
4. The pipeline catches this, logs the approve/deny URLs, and optionally DMs you
5. `GET /approve/:token` sets status to `approved` then calls `executePermission(corsair, token)` — Corsair replays the exact frozen API call
6. `GET /deny/:token` sets status to `denied` — the call is permanently discarded
7. All records survive server restarts (SQLite file on disk)

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | OpenAI API key — used for gpt-4o-mini content generation |
| `CORSAIR_KEK` | Yes | 32-byte base64 encryption key for Corsair (`openssl rand -base64 32`) |
| `CORSAIR_DB_PATH` | No | Path to the SQLite DB file (default: `./corsair.db`) |
| `GITHUB_TOKEN` | Yes | GitHub PAT with repo read access |
| `GITHUB_WEBHOOK_SECRET` | No | Webhook secret for signature verification (recommended in production) |
| `SLACK_BOT_TOKEN` | Yes | Slack bot OAuth token (`xoxb-...`) |
| `SLACK_CHANNEL` | Yes | Channel ID or name to post announcements to |
| `SLACK_SIGNING_SECRET` | No | Slack signing secret for request verification |
| `NOTION_API_KEY` | Yes | Notion integration token (`secret_...`) |
| `NOTION_PARENT_PAGE_ID` | Yes | ID of the Notion page to create release pages under |
| `REQUIRE_APPROVAL` | No | `true` → strict permission mode; `false` (default) → open |
| `SLACK_APPROVER_ID` | No | Your Slack user ID — receives a DM when approval is needed |
| `PUBLIC_URL` | No | Public base URL for approve/deny links (e.g. your ngrok URL) |
| `PORT` | No | HTTP port (default: `3000`) |

---

## Customizing

**Change the model**: Edit `pipeline.ts` → `generateContent()` — swap `gpt-4o-mini` for any OpenAI model.

**Customize the AI tone**: Edit the prompt in `pipeline.ts` → `generateContent()`.

**Change the Slack channel**: Update `SLACK_CHANNEL` in `.env`.

**Add Twitter/X posting**: Use the generated `content.tweetThread` array in `pipeline.ts`.

---

## Deploying to production

The server is a plain Node.js Express app. `corsair.db` is the only stateful file — mount it as a persistent volume.

**Railway** (easiest):
```bash
railway init
railway up
```

**Docker**:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json .
RUN npm ci --production
COPY dist/ dist/
ENV CORSAIR_DB_PATH=/data/corsair.db
CMD ["node", "dist/index.js"]
```
Mount `/data` as a persistent volume so the SQLite DB survives redeploys.

Set all env vars in your hosting platform's dashboard — never commit `.env`.
