import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// File name: `middleware.ts`, NOT `proxy.ts`.
//
// The Clerk Phase 2 plan called for `proxy.ts` (Next.js 16's preferred name
// for the deprecated `middleware.ts`). That does not work here: Next.js 16
// made `proxy.ts` Node.js-only (the `runtime` segment config is rejected
// outright — "Proxy always runs on Node.js runtime"), but OpenNext-on-
// Cloudflare-Workers only supports Edge middleware ("Node.js middleware is
// not currently supported. Consider switching to Edge Middleware."). The
// legacy `middleware.ts` name still defaults to Edge and is the only path
// that builds under OpenNext today. Tracked as a deviation from the plan;
// revisit when OpenNext supports Node.js proxy (or Next.js 17 removes
// `middleware.ts` entirely — at which point we'll need a different fix).
//
// Sign-in URL is configured via NEXT_PUBLIC_CLERK_SIGN_IN_URL (set in
// .env.production and .dev.vars). Clerk's auth.protect() redirects
// unauthenticated users there.

// ─── Matched routes exempted from auth.protect() ─────────────────────────────
//
// These still run through `clerkMiddleware` (so `auth()` is populated for the
// human-actor fall-through), but skip `auth.protect()` because the handler
// performs its own layered auth. Exported so the middleware-routing test can
// assert the exemption list without reading source text; consumed directly by
// `createRouteMatcher` below (single-sourced — no duplicate list).
export const PUBLIC_ROUTES: string[] = [
  "/receipts/sign-in(.*)",
  // Processor-only routes — Mac MLX consumer (ADR 0001). These do layered
  // auth INSIDE the route handler: valid `x-receipts-processor-key` header
  // OR a Clerk-authenticated human actor (file: GET/HEAD at
  // app/api/receipts/[id]/file/route.ts:61,94; extract: POST at
  // app/api/receipts/[id]/extract/route.ts:52-58). They MUST stay matched
  // (via /api/receipts/:path* in config.matcher) so clerkMiddleware RUNS and
  // `auth()` is populated for the human-actor fall-through
  // (requireReceiptsActor in lib/receipts/auth.ts reads `auth()`).
  // Listing them here only skips `auth.protect()`; the handler then decides
  // based on the header. Without this exemption, Phase 2's `auth.protect()`
  // 404-rewrites processor-key requests before the handler runs — which is
  // what silently dropped 17 receipts between Jul 4 (PR #59 shipped) and
  // this fix.
  "/api/receipts/:id/file",
  "/api/receipts/:id/extract",
  "/api/receipts/:id/extraction-failed",
  "/api/receipts/:id/proof",
  // ADR 0011 Phase B (option b): the Mac consumer drives the body pipeline.
  // render: consumer deposits the Mac-rendered body derivative. promote: the
  // consumer auto-promotes allowlisted body-only intakes. Both do processor-key
  // OR Clerk layered auth inside the handler (mirroring file/extract/proof), so
  // they MUST be exempt from auth.protect() here — without this, Clerk
  // 404-rewrites the consumer's processor-key POST before the handler runs.
  "/api/receipts/:id/render",
  "/api/receipts/inbox/:id/promote",
];

// Exported so the middleware-routing test can assert a route is actually
// exempted (or not) by running the real matcher — not by eyeballing the array.
// Used to guard the monthly-delivery send endpoint (it emails the financial
// pack to a configured address): it MUST stay under auth.protect(), i.e. never
// match a PUBLIC_ROUTES entry.
export const isPublicRoute = createRouteMatcher(PUBLIC_ROUTES);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    // MUST `await` the promise. `auth.protect()` throws synchronously inside
    // an async wrapper when the user is signed out, which converts the throw
    // to a Promise rejection. Without `await` (or `return`), the rejection is
    // silently dropped and the request falls through to the page — making the
    // middleware a no-op. Verified against @clerk/nextjs 7.5.12 source
    // (createProtect in dist/esm/server/protect.js).
    await auth.protect();
  }
});

// IMPORTANT: server-side `auth()` — used by `requireReceiptsActor()` in
// `lib/receipts/auth.ts` (→ `auth()` / `clerkClient()`) — REQUIRES
// `clerkMiddleware()` to run for the request. It does NOT read the Clerk
// session cookie on its own: `@clerk/nextjs` documents `auth()` as "Requires
// `clerkMiddleware()` to be configured", and the runtime raises
// `auth_signature_invalid` ("the Clerk middleware did not run … matches the
// current route") when it didn't. Therefore every `/api/*` handler that calls
// `requireReceiptsActor` MUST be matched here.
//
// The one `/api/mobile/*` matched route is `/api/mobile/auth/complete-pairing`:
// the browser-side operator-approval POST ("Pair this iPhone"), whose handler
// calls `requireReceiptsActor`. Every OTHER `/api/mobile/*` endpoint uses a
// device-bearer token or a pairing code and is intentionally NOT matched.
//
// NOTE: `matcher` MUST be a static array literal — Next.js statically extracts
// `config.matcher` at build time and rejects variable references. So the
// matcher list lives inline here as the canonical source; the middleware-
// routing test asserts against `config.matcher` directly (no duplicated list).
export const config = {
  matcher: [
    "/receipts/:path*",
    "/admin/:path*",
    "/api/receipts/:path*",
    // Operator-approval POST from /receipts/pair: its handler calls
    // requireReceiptsActor → auth()/clerkClient(), which only returns usable
    // identity when clerkMiddleware ran on the request. The ONE /api/mobile/*
    // route that is Clerk-matched.
    "/api/mobile/auth/complete-pairing",
  ],
};
