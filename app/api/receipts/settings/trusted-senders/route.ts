import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { isValidSenderEmail, listTrustedSenders } from "@/lib/receipts/trusted-senders";
import { trustSender, untrustSender } from "@/lib/receipts/sender-policy";
import { getSenderControlsSnapshot } from "@/lib/receipts/sender-activity";

// Settings page backing for the ADR 0011 Phase B auto-promote allowlist
// (trusted_intake_senders). Clerk-gated like the compliance settings route
// (requireReceiptsActor) — this route is for the human-facing Settings page only;
// the Mac consumer reads the same table directly via wrangler/D1 (a separate
// auth path), so there is no processor-key variant here.

export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    const senders = await listTrustedSenders(getReceiptsDb());
    return NextResponse.json({ senders }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/trusted-senders] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load trusted senders." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const body = (await request.json().catch(() => ({}))) as { email?: unknown };
    const email = typeof body.email === "string" ? body.email : "";
    if (!email || !isValidSenderEmail(email)) {
      return NextResponse.json(
        { error: "A valid email address (local@domain.tld) is required." },
        { status: 400 },
      );
    }
    const db = getReceiptsDb();
    await trustSender(db, email, actor);
    const snapshot = await getSenderControlsSnapshot(db);
    return NextResponse.json(snapshot, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/trusted-senders] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to add sender." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    // Accept the email from the JSON body OR a ?email= query param (DELETE
    // bodies are awkward to send from some clients).
    const body = (await request.json().catch(() => ({}))) as { email?: unknown };
    const fromBody = typeof body.email === "string" ? body.email : "";
    const fromQuery = new URL(request.url).searchParams.get("email") ?? "";
    const email = fromBody || fromQuery;
    if (!email) {
      return NextResponse.json(
        { error: "email is required." },
        { status: 400 },
      );
    }
    const db = getReceiptsDb();
    await untrustSender(db, email, actor);
    const snapshot = await getSenderControlsSnapshot(db);
    return NextResponse.json(snapshot, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/trusted-senders] DELETE failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to remove sender." },
      { status: 500 },
    );
  }
}
