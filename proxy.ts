import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getAdminPageAuthChallengeHeaders,
  isAdminPageAuthConfigured,
  isAdminPageAuthorized,
} from "@/lib/admin-page-auth";

export function proxy(request: NextRequest) {
  if (!isAdminPageAuthConfigured()) {
    return new NextResponse("Not Found", {
      status: 404,
      headers: { "X-Robots-Tag": "noindex, nofollow" },
    });
  }

  if (isAdminPageAuthorized(request.headers)) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      ...getAdminPageAuthChallengeHeaders(),
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export const config = {
  matcher: ["/admin/:path*"],
};
