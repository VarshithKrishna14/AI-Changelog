# AI Changelog Narrator

> Tag a GitHub release. Your AI writes the changelog and tells the world.

**What it does:** When you publish a GitHub release, this agent automatically:
1. Reads the release notes and recent commits
2. Generates a human-readable changelog, Slack post, and tweet thread using Nebius AI Studio
3. Posts the announcement to Slack
4. Archives everything in a Notion page

**Built with [Corsair](https://corsair.dev)** — the integration layer for AI agents.  
**LLM:** [Nebius AI Studio](https://studio.nebius.ai) — `meta-llama/Llama-3.3-70B-Instruct` via OpenAI-compatible API.

---

## Demo

```
You publish v1.3.0 on GitHub
       ↓
Corsair receives the webhook
       ↓
Nebius AI reads commits + generates content
       ↓
┌─────────────────────────────────────┐
│  Slack: #releases announcement      │
│  Notion: full release archive page  │
└─────────────────────────────────────┘
All done in ~15 seconds.
```

---

## Setup

### 1. Clone and install

```bash
cd ai-changelog-narrator
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in all values (see comments for where to get each one).

### 3. Generate your encryption key

```bash
openssl rand -base64 32
# Paste the output as CORSAIR_KEK in .env
```

### 4. Add integration credentials to `.env`

This project uses direct plugin credentials from environment variables (no separate setup command):

- `GITHUB_TOKEN` — GitHub PAT with repo access
- `SLACK_BOT_TOKEN` — Slack bot token (`xoxb-...`)
- `NOTION_API_KEY` — Notion integration token
- `SLACK_SIGNING_SECRET` and `GITHUB_WEBHOOK_SECRET` — optional but recommended for production

### 5. Configure the GitHub webhook

In your GitHub repo → Settings → Webhooks → Add webhook:
- **Payload URL**: `https://your-server.com/webhook`  
  (use [ngrok](https://ngrok.com) for local dev: `ngrok http 3000`)
- **Content type**: `application/json`
- **Events**: Select "Releases" only
- **Secret**: Leave blank for local testing, or use `GITHUB_WEBHOOK_SECRET` in production

### 6. Share the Notion integration with your page

In Notion, open the parent page you want release pages created under:
- Click `...` → Connections → Connect to your Corsair integration

### 7. Start the server

```bash
# Development (auto-restarts on change)
npm run dev

# Production
npm run build && npm start
```

---

## How it works

```
src/
├── index.ts     Entry point — starts server
├── db.ts        Placeholder module (DB not required in current mode)
├── corsair.ts   Corsair instance (GitHub + Slack + Notion)
│                Registers the release.published webhook hook
├── pipeline.ts  Core pipeline:
│                  1. Get previous release tag
│                  2. Fetch commits since last release
│                  3. Call Nebius AI to generate all content
│                  4. Post to Slack and create Notion page
└── server.ts    Express server with /webhook and /health endpoints
```

### Corsair handles the hard parts
- Webhook routing and typed integration APIs
- API retries and rate limiting
- Typed API calls — no raw fetch, no string soup

---

## Deploying to production

The server is a plain Node.js Express app. Any platform works:

**Railway** (easiest):
```bash
railway init
railway up
```

**Fly.io**:
```bash
fly launch
fly deploy
```

**Docker**:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json .
RUN npm ci --production
COPY dist/ dist/
COPY .env .env
CMD ["node", "dist/index.js"]
```

Set all env vars in your hosting platform's dashboard (not in a committed `.env`).

---

## Customizing

**Change the Slack channel**: Update `SLACK_CHANNEL` in `.env`.

**Customize the AI tone**: Edit the prompt in `src/pipeline.ts` → `generateContent()`.

**Add Twitter/X posting**: Wire in the Twitter API in `pipeline.ts` — use the generated `content.tweetThread` array.

**Skip draft releases**: Already handled — drafts are filtered in `src/corsair.ts`.

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `CORSAIR_KEK` | Yes | 32-char encryption key for Corsair |
| `NEBIUS_API_KEY` | Yes | Nebius AI Studio API key (from studio.nebius.ai) |
| `GITHUB_TOKEN` | Yes | GitHub personal access token |
| `GITHUB_WEBHOOK_SECRET` | No | GitHub webhook secret (recommended in production) |
| `SLACK_CHANNEL` | Yes | Slack channel ID or name |
| `SLACK_BOT_TOKEN` | Yes | Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | No | Slack signing secret (recommended in production) |
| `NOTION_API_KEY` | Yes | Notion integration token |
| `NOTION_PARENT_PAGE_ID` | Yes | Parent Notion page ID |
| `PORT` | No | Server port (default: 3000) |

---

## Social hook

> "I tagged a release and my AI did the rest. Zero marketing posts written by me."

Record a 60-second screen capture:
1. Hit "Publish release" on GitHub
2. Watch the terminal — pipeline logs appear in real-time
3. Cut to Slack showing the announcement
4. Cut to the email in your inbox
5. Cut to the Notion page

Post to X with the hook above. Done.
