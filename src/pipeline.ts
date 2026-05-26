import OpenAI from 'openai';
import type { GitHubRelease, GitHubRepository } from './corsair.js';
import { corsair, writeMode } from './corsair.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? '',
});

// ---- Config from env ----

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required. Get it from https://platform.openai.com/api-keys');
}

// ---- Main pipeline ----

export interface PipelineInput {
  release: GitHubRelease;
  repository: GitHubRepository;
}

export async function runPipeline({ release, repository }: PipelineInput) {
  const owner = repository.owner.login;
  const repo = repository.name;
  const tag = release.tag_name;
  const releaseName = release.name ?? tag;
  const releaseUrl = release.html_url;
  const releaseBody = release.body ?? '';
  const publishedAt = release.published_at ?? release.created_at;

  console.log(`\n══════════════════════════════════════════`);
  console.log(`[pipeline] ▶ Starting  ${owner}/${repo} @ ${tag}`);
  console.log(`[pipeline]   releaseName="${releaseName}"  url="${releaseUrl}"`);
  console.log(`[pipeline]   OPENAI_API_KEY present: ${!!process.env.OPENAI_API_KEY}`);
  console.log(`[pipeline]   SLACK_BOT_TOKEN present: ${!!(process.env.SLACK_BOT_TOKEN ?? process.env.SLACK_KEY)}`);
  console.log(`[pipeline]   SLACK_CHANNEL="${process.env.SLACK_CHANNEL ?? '(not set)'}"`);
  console.log(`[pipeline]   NOTION_API_KEY present: ${!!(process.env.NOTION_API_KEY ?? process.env.NOTION_KEY)}`);
  console.log(`[pipeline]   NOTION_PARENT_PAGE_ID="${process.env.NOTION_PARENT_PAGE_ID ?? '(not set)'}"`);
  console.log(`[pipeline]   GITHUB_TOKEN present: ${!!(process.env.GITHUB_TOKEN ?? process.env.GITHUB_API_KEY)}`);

  // 1. Fetch the previous release to determine commit range
  console.log(`[pipeline] Step 1 — fetching previous release tag…`);
  const previousTag = await getPreviousReleaseTag(owner, repo, release.id);
  console.log(`[pipeline] Previous release tag: ${previousTag ?? 'none (first release)'}`);

  // 2. Fetch recent commits since previous release (or last 50 if first release)
  console.log(`[pipeline] Step 2 — fetching commits…`);
  const commits = await getCommitsSince(owner, repo, tag, previousTag, publishedAt);
  console.log(`[pipeline] Found ${commits.length} commits`);

  // 3. Generate all content with a single Nebius AI call
  console.log(`[pipeline] Step 3 — calling OpenAI (model: gpt-4o-mini)…`);
  const generated = await generateContent({
    repoName: repo,
    repoUrl: repository.html_url,
    repoDescription: repository.description ?? '',
    tag,
    releaseName,
    releaseUrl,
    releaseBody,
    previousTag,
    commits,
    author: release.author.login,
    publishedAt,
  });

  console.log(`[pipeline] ✅ Content generated — oneLiner="${generated.oneLiner?.slice(0, 80)}…"`);

  // 4. Broadcast — Corsair's permission layer handles gating when REQUIRE_APPROVAL=true.
  //    With writeMode='strict', calls to messages.post and pages.createPage are intercepted:
  //    Corsair stores the full args in corsair_permissions and throws with the approval token.
  //    We catch those throws, log/DM the review URLs, and let humans approve via /approve/:token.
  const baseUrl = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  console.log(`[pipeline] Step 4 — posting to Slack & Notion (permission mode: ${writeMode})…`);

  const results = await Promise.allSettled([
    postToSlack(generated, releaseName, tag, releaseUrl, repo),
    createNotionPage(generated, releaseName, tag, releaseUrl, repo, publishedAt, commits),
  ]);

  for (const [i, result] of results.entries()) {
    const label = ['Slack', 'Notion'][i]!;
    if (result.status === 'rejected') {
      const token = parseCorsairApprovalToken(result.reason);
      if (token) {
        console.log(`[pipeline] ⏸  ${label} blocked — Corsair requires approval.`);
        console.log(`[pipeline]    Token:   ${token}`);
        console.log(`[pipeline]    Approve: ${baseUrl}/approve/${token}`);
        console.log(`[pipeline]    Deny:    ${baseUrl}/deny/${token}`);
        console.log(`[pipeline]    List:    ${baseUrl}/pending`);
        await notifyApproverDirect(token, repo, tag, baseUrl, label).catch((err) =>
          console.warn(`[approvals] Could not DM approver:`, err),
        );
      } else {
        console.error(`[pipeline] ❌ ${label} FAILED:`, result.reason);
      }
    } else {
      console.log(`[pipeline] ✅ ${label} done`);
    }
  }

  console.log('[pipeline] ▶ Complete\n');
}

// ---- Step 1: Get previous release tag ----

async function getPreviousReleaseTag(
  owner: string,
  repo: string,
  currentReleaseId: number,
): Promise<string | null> {
  try {
    const releases = await corsair.github.api.releases.list({
      owner,
      repo,
      perPage: 10,
    });

    // Releases are returned newest-first. Find the one immediately before current.
    const idx = releases.findIndex((r) => r.id === currentReleaseId);
    if (idx === -1 || idx === releases.length - 1) return null;

    const previous = releases[idx + 1];
    return previous?.tagName ?? null;
  } catch {
    return null;
  }
}

// ---- Step 2: Fetch commits ----

interface Commit {
  sha: string;
  message: string;
  author: string;
  url: string;
}

async function getCommitsSince(
  owner: string,
  repo: string,
  currentTag: string,
  previousTag: string | null,
  publishedAt: string,
): Promise<Commit[]> {
  try {
    // Use the current tag as the sha to list commits up to that point
    // and `since` to filter by previous release date
    const since = previousTag
      ? // Get the previous release's date via another list call — simpler than compare API
        undefined // We use sha scoping below
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // Last 30 days for first release

    const rawCommits = await corsair.github.api.repositories.listCommits({
      owner,
      repo,
      sha: currentTag,
      since,
      perPage: 50,
    });

    return rawCommits.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0], // First line only
      author: c.commit.author?.name ?? c.commit.committer?.name ?? 'unknown',
      url: c.htmlUrl ?? '',
    }));
  } catch (err) {
    console.warn('[pipeline] Could not fetch commits:', err);
    return [];
  }
}

// ---- Step 3: Generate content via Nebius AI ----

interface GenerateInput {
  repoName: string;
  repoUrl: string;
  repoDescription: string;
  tag: string;
  releaseName: string;
  releaseUrl: string;
  releaseBody: string;
  previousTag: string | null;
  commits: Commit[];
  author: string;
  publishedAt: string;
}

interface GeneratedContent {
  changelog: string;        // Markdown changelog (clean, human-readable)
  slackMessage: string;     // Plain text Slack announcement
  tweetThread: string[];    // Array of tweet strings (each ≤ 280 chars)
  oneLiner: string;         // Single-sentence TL;DR
}

async function generateContent(input: GenerateInput): Promise<GeneratedContent> {
  const commitList = input.commits.length > 0
    ? input.commits
        .slice(0, 30) // Cap at 30 commits in the prompt
        .map((c) => `- ${c.sha} ${c.message} (${c.author})`)
        .join('\n')
    : 'No commit data available.';

  const prompt = `You are a technical writer for an open-source project.

A new release has just been published. Your job is to create clear, engaging content that developers will love to read.

## Release Info
- Repository: ${input.repoName}
- Tag: ${input.tag}
- Release name: ${input.releaseName}
- Published by: ${input.author}
- Previous release: ${input.previousTag ?? 'none (first release)'}
- Release URL: ${input.releaseUrl}
- Description from author:
${input.releaseBody || '(no description provided)'}

## Commits in this release
${commitList}

## Your task
Generate a JSON object with these exact keys:

{
  "oneLiner": "A single sentence summarizing what changed. Max 120 chars.",
  "changelog": "A clean markdown changelog. Use sections: ## What's New, ## Bug Fixes, ## Breaking Changes (only if applicable), ## Full Changelog. Group commits by type. Write in past tense. Keep each bullet concise.",
  "slackMessage": "A casual, developer-friendly Slack announcement. 2-4 sentences. Include the release name and a link. No markdown headers — use *bold* for emphasis. End with the release URL.",
  "tweetThread": ["Tweet 1 (max 280 chars, hook — make them want to read more)", "Tweet 2 (max 280 chars, key feature or fix highlight)", "Tweet 3 (max 280 chars, call to action with the release URL ${input.releaseUrl})"]
}

Return ONLY the JSON object, no markdown code fences, no extra text.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 4096,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content: 'You are a technical writer who produces JSON. Always respond with valid JSON only — no markdown fences, no extra text.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const text = response.choices[0]?.message?.content ?? '';

  try {
    return JSON.parse(text) as GeneratedContent;
  } catch (firstErr) {
    console.warn(`[openai] First JSON.parse failed (${firstErr}), trying to strip markdown fences…`);
    console.warn(`[openai] Raw response (first 500 chars): ${text.slice(0, 500)}`);
    // Strip any accidental markdown fences and retry
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '');
    try {
      return JSON.parse(cleaned) as GeneratedContent;
    } catch (secondErr) {
      console.error(`[openai] ❌ Could not parse OpenAI response as JSON:`, secondErr);
      console.error(`[openai] Full raw text: ${text}`);
      throw new Error(`Nebius returned non-JSON: ${secondErr}`);
    }
  }
}

// ---- Corsair approval helpers ───────────────────────────────────────────────

/**
 * Extracts the Corsair permission token from an error thrown by the permission layer.
 * Corsair embeds it via approval.formatAsyncMessage → "CORSAIR:APPROVAL_REQUIRED token=<hex> …"
 */
function parseCorsairApprovalToken(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const m = err.message.match(/CORSAIR:APPROVAL_REQUIRED token=([a-f0-9]+)/);
  return m?.[1] ?? null;
}

/**
 * Sends a Slack DM directly via fetch (bypasses Corsair's permission check).
 * Required because with mode='strict', even messages.post through Corsair would be blocked.
 */
async function notifyApproverDirect(
  token: string,
  repo: string,
  tag: string,
  baseUrl: string,
  action: string,
): Promise<void> {
  const approverId = process.env.SLACK_APPROVER_ID;
  if (!approverId) return;
  const botToken = process.env.SLACK_BOT_TOKEN ?? process.env.SLACK_KEY;
  if (!botToken) return;

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: approverId,
      text: `⏸ *${repo} ${tag}* — ${action} post is waiting for your approval.\n\n✅ Approve: ${baseUrl}/approve/${token}\n❌ Deny:    ${baseUrl}/deny/${token}\n📋 All pending: ${baseUrl}/pending`,
    }),
  });

  if (!res.ok) {
    console.warn(`[approvals] Slack DM HTTP error: ${res.status}`);
  } else {
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      console.warn(`[approvals] Slack DM API error: ${data.error}`);
    } else {
      console.log(`[approvals] ✅ DM sent to approver ${approverId}`);
    }
  }
}

// ---- Block/children builders ────────────────────────────────────────────────

function buildSlackBlocks(
  content: GeneratedContent,
  tag: string,
  releaseUrl: string,
  repo: string,
): unknown[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${repo} ${tag} released`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: content.slackMessage },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*TL;DR* ${content.oneLiner}` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Release', emoji: true },
          url: releaseUrl,
          action_id: 'view_release',
          style: 'primary',
        },
      ],
    },
  ];
}

function buildNotionChildren(
  content: GeneratedContent,
  releaseUrl: string,
  commits: Commit[],
): unknown[] {
  return [
    {
      object: 'block' as const,
      type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content: content.oneLiner } }],
        icon: { type: 'emoji', emoji: '📦' },
        color: 'blue_background',
      },
    },
    { object: 'block' as const, type: 'divider', divider: {} },
    {
      object: 'block' as const,
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: 'Changelog' } }] },
    },
    {
      object: 'block' as const,
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: content.changelog } }] },
    },
    { object: 'block' as const, type: 'divider', divider: {} },
    {
      object: 'block' as const,
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: `Commits (${commits.length})` } }] },
    },
    ...commits.slice(0, 20).map((c) => ({
      object: 'block' as const,
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [
          { type: 'text', text: { content: `${c.sha}  ${c.message}` } },
          { type: 'text', text: { content: ` — ${c.author}`, link: null } },
        ],
      },
    })),
    { object: 'block' as const, type: 'divider', divider: {} },
    {
      object: 'block' as const,
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: 'Social Content' } }] },
    },
    {
      object: 'block' as const,
      type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: 'Tweet Thread' } }] },
    },
    ...content.tweetThread.map((tweet) => ({
      object: 'block' as const,
      type: 'quote',
      quote: { rich_text: [{ type: 'text', text: { content: tweet } }] },
    })),
    {
      object: 'block' as const,
      type: 'bookmark',
      bookmark: { url: releaseUrl, caption: [] },
    },
  ];
}

// ---- Step 4a: Post to Slack ────────────────────────────────────────────────

async function postToSlack(
  content: GeneratedContent,
  releaseName: string,
  tag: string,
  releaseUrl: string,
  repo: string,
) {
  console.log(`[slack] posting to channel…`);
  const channel = requireEnv('SLACK_CHANNEL');
  console.log(`[slack] SLACK_CHANNEL="${channel}"`);
  const blocks = buildSlackBlocks(content, tag, releaseUrl, repo);
  console.log(`[slack] calling corsair.slack.api.messages.post…`);
  await corsair.slack.api.messages.post({
    channel,
    text: `${repo} ${releaseName} is out! ${content.oneLiner}`,
    blocks: blocks as Parameters<typeof corsair.slack.api.messages.post>[0]['blocks'],
  });
  console.log(`[slack] ✅ message posted`);
}

// ---- Step 4b: Create Notion page ───────────────────────────────────────────

async function createNotionPage(
  content: GeneratedContent,
  releaseName: string,
  tag: string,
  releaseUrl: string,
  repo: string,
  publishedAt: string,
  commits: Commit[],
) {
  console.log(`[notion] creating page…`);
  const parentPageId = requireEnv('NOTION_PARENT_PAGE_ID');
  console.log(`[notion] NOTION_PARENT_PAGE_ID="${parentPageId}"`);
  const date = new Date(publishedAt).toISOString().split('T')[0];
  const children = buildNotionChildren(content, releaseUrl, commits);

  console.log(`[notion] calling corsair.notion.api.pages.createPage…`);
  await (corsair.notion.api.pages.createPage as unknown as (args: Record<string, unknown>) => Promise<unknown>)({
    parent: { type: 'page_id', page_id: parentPageId },
    properties: {
      title: {
        title: [{ text: { content: `${repo} ${releaseName} — ${date}` } }],
      },
    } as Record<string, unknown>,
    children: children as unknown as Record<string, unknown>[],
  });
  console.log(`[notion] ✅ page created`);
}
