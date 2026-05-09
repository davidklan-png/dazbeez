import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getAdminPageAuthChallengeHeaders,
  isAdminPageAuthConfigured,
  isAdminPageAuthorized,
} from "@/lib/admin-page-auth";
import {
  getReceiptsAuthChallengeHeaders,
  isReceiptsAuthorizedLight,
} from "@/lib/receipts/auth";

const NOINDEX = { "X-Robots-Tag": "noindex, nofollow" } as const;

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // www → canonical redirect
  if (request.headers.get("host") === "www.dazbeez.com") {
    const url = request.nextUrl.clone();
    url.host = "dazbeez.com";
    return NextResponse.redirect(url, 308);
  }

  // Receipt module — trusted-device cookie (primary), CF Access JWT
  // (enrollment), or basic auth (local dev). Browsers without a valid
  // session are redirected to /receipts/enroll so Cloudflare Access (which
  // protects only the enroll route at the edge) can issue an identity.
  if (
    pathname.startsWith("/receipts") ||
    pathname.startsWith("/api/receipts")
  ) {
    const authorized = await isReceiptsAuthorizedLight(request.headers);
    if (!authorized) {
      const isEnrollPath =
        pathname === "/receipts/enroll" ||
        pathname.startsWith("/api/receipts/devices/enroll");
      const wantsHtml =
        !isEnrollPath &&
        (request.headers.get("accept") ?? "").includes("text/html");
      if (wantsHtml) {
        const url = request.nextUrl.clone();
        url.pathname = "/receipts/enroll";
        url.search = `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
        return NextResponse.redirect(url, 302);
      }
      return new NextResponse("Authentication required.", {
        status: 401,
        headers: { ...getReceiptsAuthChallengeHeaders(), ...NOINDEX },
      });
    }
    return NextResponse.next({
      headers: NOINDEX,
    });
  }

  // Admin CRM
  if (!pathname.startsWith("/admin")) {
    return NextResponse.next();
  }

  if (!isAdminPageAuthConfigured()) {
    return new NextResponse("Not Found", {
      status: 404,
      headers: NOINDEX,
    });
  }

  if (isAdminPageAuthorized(request.headers)) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { ...getAdminPageAuthChallengeHeaders(), ...NOINDEX },
  });
}

export const config = {
  matcher: ["/:path*"],
};
