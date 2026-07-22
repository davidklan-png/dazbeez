import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { listBlockedSenders } from "@/lib/receipts/blocked-senders";
import { isValidSenderEmail } from "@/lib/receipts/trusted-senders";
import { blockSender, unblockSender } from "@/lib/receipts/sender-policy";

// Settings page backing for the ADR 0011 follow-up sender blocklist.
// Uses the canonical sender-policy transitions (mutual-exclusion-safe).

export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    const senders = await listBlockedSenders(getReceiptsDb());
    return NextResponse.json({ senders }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/blocked-senders] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load blocked senders." },
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
    await blockSender(getReceiptsDb(), email, actor);
    const senders = await listBlockedSenders(getReceiptsDb());
    return NextResponse.json({ senders }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/blocked-senders] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to block sender." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const body = (await request.json().catch(() => ({}))) as { email?: unknown };
    const fromBody = typeof body.email === "string" ? body.email : "";
    const fromQuery = new URL(request.url).searchParams.get("email") ?? "";
    const email = fromBody || fromQuery;
    if (!email) {
      return NextResponse.json({ error: "email is required." }, { status: 400 });
    }
    await unblockSender(getReceiptsDb(), email, actor);
    const senders = await listBlockedSenders(getReceiptsDb());
    return NextResponse.json({ senders }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/blocked-senders] DELETE failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to unblock sender." },
      { status: 500 },
    );
  }
}
