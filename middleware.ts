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

const isPublicRoute = createRouteMatcher([
  "/receipts/sign-in(.*)",
  "/receipts/enroll(.*)", // redirect shim → /receipts/sign-in; must not be gated
]);

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

export const config = {
  matcher: [
    "/receipts/:path*",
    "/admin/:path*",
    "/api/receipts/:path*",
    // /api/mobile/* intentionally NOT matched (bearer-token scheme, never Clerk)
  ],
};
