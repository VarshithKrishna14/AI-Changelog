import 'dotenv/config';
import { createCorsair } from 'corsair';
import { github } from '@corsair-dev/github';
import { slack } from '@corsair-dev/slack';
import { notion } from '@corsair-dev/notion';
import { rawDbInput } from './db.js';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required in .env`);
  return value;
}

function requireFirstEnv(keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  throw new Error(`One of ${keys.join(', ')} is required in .env`);
}

/**
 * Permission mode for write-capable plugins (Slack, Notion).
 *
 * | REQUIRE_APPROVAL | mode    | read  | write (messages.post, pages.createPage)  |
 * |------------------|---------|-------|------------------------------------------|
 * | false (default)  | open    | allow | allow — posts immediately                |
 * | true             | strict  | allow | require_approval — parks in DB, throws   |
 *
 * The error thrown when blocked contains the approval token via formatAsyncMessage.
 * POST /approve/:token executes the stored call; GET /deny/:token discards it.
 */
export const writeMode: 'open' | 'strict' =
  process.env.REQUIRE_APPROVAL === 'true' ? 'strict' : 'open';

export const corsair = createCorsair({
  plugins: [
    github({
      credentials: { token: requireFirstEnv(['GITHUB_TOKEN', 'GITHUB_API_KEY']) },
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
      // This project only reads from GitHub — lock it down.
      permissions: { mode: 'readonly' },
    }),

    slack({
      key: requireFirstEnv(['SLACK_BOT_TOKEN', 'SLACK_KEY']),
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      // 'strict'  → messages.post is intercepted; token stored in corsair_permissions.
      // 'open'    → messages.post executes immediately (default).
      permissions: { mode: writeMode },
    }),

    notion({
      key: requireFirstEnv(['NOTION_API_KEY', 'NOTION_KEY']),
      // 'strict'  → pages.createPage is intercepted; token stored in corsair_permissions.
      // 'open'    → pages.createPage executes immediately (default).
      permissions: { mode: writeMode },
    }),
  ],

  // Wire Corsair's built-in permission system to our SQLite database.
  // Pass the raw adapter so createCorsair can wrap it with its own dialect + plugin.
  // Without this, require_approval falls back to deny.
  database: rawDbInput,

  // Required by Corsair type signature.
  kek: process.env.CORSAIR_KEK ?? 'dev-only-kek-replace-in-production',
  multiTenancy: false,

  approval: {
    timeout: '1h',
    onTimeout: 'deny',
    mode: 'asynchronous',
    // Embed the token in the error message thrown to the pipeline caller.
    // Pattern: CORSAIR:APPROVAL_REQUIRED token=<hex> plugin=<id> endpoint=<path>
    formatAsyncMessage: ({ token, plugin, endpoint }) =>
      `CORSAIR:APPROVAL_REQUIRED token=${token} plugin=${plugin} endpoint=${endpoint}`,
  },
});

// ---- Payload types from the GitHub release.published webhook ----

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string;
  author: {
    login: string;
    avatar_url: string;
    html_url: string;
  };
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  owner: {
    login: string;
  };
}
