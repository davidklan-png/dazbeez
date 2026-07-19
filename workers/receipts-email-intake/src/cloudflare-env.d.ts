// Worker-local CloudflareEnv stub (ADR 0011 intake worker).
//
// Why this exists: lib/receipts/email-intake.ts (shared with the OpenNext app)
// transitively imports lib/cloudflare-runtime.ts, whose getReceiptsDb() etc.
// cast the env to `CloudflareEnv`. This worker calls only recordIntake(), which
// does NOT touch cloudflare-runtime — and the bundler proves it: `getCloudflareContext`
// and every cloudflare-runtime symbol are tree-shaken out of the published bundle
// (0 occurrences, verified via `wrangler deploy --dry-run`). But tsc --noEmit
// type-checks the whole transitive import graph, so it still visits cloudflare-runtime.ts
// and needs `CloudflareEnv` to carry these members.
//
// We cannot include the main app's cloudflare-env.d.ts here: `wrangler types`
// regenerated it with the ENTIRE workerd runtime global surface inlined (472 KB /
// 13k lines), which would redeclare Workers globals and collide with
// `@cloudflare/workers-types`. Instead this file declares just the env binding
// members (interface declaration merging adds them). Source of truth for the
// real bindings is the main app's cloudflare-env.d.ts; this stub mirrors it.
interface CloudflareEnv {
  CRM_IMAGES: R2Bucket;
  RECEIPTS_BUCKET: R2Bucket;
  RECEIPTS_ARCHIVE_BUCKET: R2Bucket;
  DB: D1Database;
  CRM_DB: D1Database;
  RECEIPTS_DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  NEXTJS_ENV: string;
  ACCOUNTANT_EMAIL: string;
  NOTIFY_FROM_ADDRESS: string;
  // Wrangler secrets (set via `wrangler secret put`) — not emitted by `wrangler
  // types`, augmented in the app via receipts-env.d.ts. Mirrored here so
  // cloudflare-runtime.ts's getResendApiKey() type-checks under this worker.
  RESEND_API_KEY: string;
  RECEIPTS_QUEUE?: Queue<unknown>;
  RECEIPTS_PROCESSOR_KEY?: string;
}
