import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { config, PUBLIC_ROUTES, isPublicRoute } from "@/middleware";

// These tests assert against the real, exported Clerk routing config —
// `config.matcher` (the exact value Next.js statically extracts at build time)
// and `PUBLIC_ROUTES` (the array middleware.ts feeds into `createRouteMatcher`).
// They guard two things at once:
//   (1) `/api/mobile/auth/complete-pairing` is Clerk-matched (its handler calls
//       requireReceiptsActor → auth(), which requires clerkMiddleware to run)
//       and is NOT public, so auth.protect() gates it.
//   (2) every OTHER /api/mobile/* route stays OUT of the matcher (device-bearer
//       / pairing-code auth), i.e. no broad /api/mobile matcher was added.

const MATCHER = config.matcher;

test("matcher: contains the exact complete-pairing route", () => {
  assert.ok(
    MATCHER.includes("/api/mobile/auth/complete-pairing"),
    "complete-pairing must be Clerk-matched so requireReceiptsActor has auth state",
  );
});

test("matcher: the complete-pairing route is the ONLY /api/mobile entry (no broad mobile matcher)", () => {
  const mobileEntries = MATCHER.filter((m) => m.includes("/api/mobile"));
  assert.deepEqual(
    mobileEntries,
    ["/api/mobile/auth/complete-pairing"],
    "no broad /api/mobile/:path* or /api/mobile/* matcher — other mobile routes must stay outside Clerk",
  );
});

test("matcher: the other mobile endpoints are not Clerk-matched", () => {
  // These use a device bearer token or a pairing code and must reach their own
  // handlers (returning their own 401), not be intercepted by Clerk.
  const otherMobile = [
    "/api/mobile/me",
    "/api/mobile/auth/revoke",
    "/api/mobile/auth/start-pairing",
    "/api/mobile/auth/check",
    "/api/mobile/receipts/upload",
    "/api/mobile/business-cards/upload",
  ];
  for (const route of otherMobile) {
    assert.ok(!MATCHER.includes(route), `${route} must not be Clerk-matched`);
  }
});

test("PUBLIC_ROUTES: complete-pairing is NOT public, so auth.protect() applies to it", () => {
  assert.ok(
    !PUBLIC_ROUTES.includes("/api/mobile/auth/complete-pairing"),
    "complete-pairing must not be exempted from auth.protect()",
  );
});

test("matcher: pre-existing gates are intact", () => {
  for (const gate of ["/receipts/:path*", "/admin/:path*", "/api/receipts/:path*"]) {
    assert.ok(MATCHER.includes(gate), `${gate} must remain matched`);
  }
});

test("matcher: the monthly-delivery send endpoint is Clerk-protected (auth.protect() applies)", () => {
  // POST /api/receipts/export/:month/send emails the financial pack to a
  // configured address. It is matched via /api/receipts/:path* and MUST NOT be
  // in the PUBLIC_ROUTES exception list (the processor-key routes) — a future
  // edit that exempted it would silently expose an endpoint that mails financial
  // records. Asserted with the real matcher so a broad new pattern cannot sneak
  // it through either.
  const sendRequest = new NextRequest(
    "https://dazbeez.com/api/receipts/export/2026-06/send",
    { method: "POST" },
  );
  assert.ok(MATCHER.includes("/api/receipts/:path*"), "the broad receipts gate covers the send route");
  assert.ok(
    !isPublicRoute(sendRequest),
    "the send route must NOT be exempted from auth.protect() (not in PUBLIC_ROUTES)",
  );
});

test("PUBLIC_ROUTES: the /enqueue recovery endpoint IS exempted (processor-key auth reaches the handler)", () => {
  // POST /api/receipts/[id]/enqueue does layered processor-key OR Clerk auth
  // inside the handler (mirroring /render, /promote). It MUST be in PUBLIC_ROUTES
  // or Clerk's auth.protect() 404-rewrites the consumer's processor-key POST
  // before the handler runs — the exact boundary bug cf:dev caught on this
  // branch (unauth returned a 404 HTML page, not the handler's 401 JSON).
  const enqueueRequest = new NextRequest(
    "https://dazbeez.com/api/receipts/00000000-0000-0000-0000-000000000000/enqueue",
    { method: "POST" },
  );
  assert.ok(
    isPublicRoute(enqueueRequest),
    "/enqueue must be exempted from auth.protect() so its handler's processor-key path runs",
  );
});
