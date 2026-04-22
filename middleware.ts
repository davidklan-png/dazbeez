import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getAdminPageAuthChallengeHeaders,
  isAdminPageAuthConfigured,
  isAdminPageAuthorized,
} from "@/lib/admin-page-auth";

export function middleware(request: NextRequest) {
  if (!isAdminPageAuthConfigured()) {
    return new NextResponse("Admin access is not configured.", { status: 503 });
  }

  if (isAdminPageAuthorized(request.headers)) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: getAdminPageAuthChallengeHeaders(),
  });
}

export const config = {
  matcher: ["/admin/:path*"],
};
