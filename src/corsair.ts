import 'dotenv/config';
import { createCorsair } from 'corsair';
import { github } from '@corsair-dev/github';
import { slack } from '@corsair-dev/slack';
import { notion } from '@corsair-dev/notion';

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

export const corsair = createCorsair({
  plugins: [
    github({
      credentials: { token: requireFirstEnv(['GITHUB_TOKEN', 'GITHUB_API_KEY']) },
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
      webhookHooks: {
        release: {
          // Fires when a GitHub release is published (not a draft)
          published: {
            after: async (_ctx, result) => {
              const payload = result as unknown as GitHubReleasePublishedPayload;

              console.log(`[webhook] release.published: ${payload.release?.tag_name ?? 'unknown tag'}`);

              // Don't process draft or pre-releases unless configured
              if (payload.release?.draft) {
                console.log('[webhook] Skipping draft release');
                return;
              }

              try {
                // Dynamic import breaks the corsair ↔ pipeline circular dependency
                const { runPipeline } = await import('./pipeline.js');
                await runPipeline({
                  release: payload.release,
                  repository: payload.repository,
                });
              } catch (err) {
                console.error('[webhook] Pipeline failed:', err);
              }
            },
          },
        },
      },
    }),

    slack({
      key: requireFirstEnv(['SLACK_BOT_TOKEN', 'SLACK_KEY']),
      signingSecret: process.env.SLACK_SIGNING_SECRET,
    }),
    notion({
      key: requireFirstEnv(['NOTION_API_KEY', 'NOTION_KEY']),
    }),
  ],
  // Required by Corsair type signature. Credentials are provided directly via plugin options.
  kek: process.env.CORSAIR_KEK ?? 'dev-only-kek-replace-in-production',
  multiTenancy: false,
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

export interface GitHubReleasePublishedPayload {
  action: 'published';
  release: GitHubRelease;
  repository: GitHubRepository;
  sender: { login: string };
}
