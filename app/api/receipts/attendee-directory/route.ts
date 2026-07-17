import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  listAttendeeDirectory,
  createAttendeeDirectoryEntry,
} from "@/lib/receipts/db";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";

// Attendee directory (migration 0022): the company/title lookup the export
// bundle's AttendeeIds column joins against. GET feeds the review-form
// datalist; POST registers a new attendee from the review UI so adding one is
// a data operation, not a code deploy. Resolution is by exact name match
// (identity = directory name), so a name typed here is the same string the
// finalize gate resolves against — no fuzzy matching.

export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    const entries = await listAttendeeDirectory();
    return NextResponse.json({ entries }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/attendee-directory] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load attendee directory." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      company?: unknown;
      title?: unknown;
    };

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const company = typeof body.company === "string" ? body.company.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";

    if (!name || !company || !title) {
      return NextResponse.json(
        { error: "name, company, and title are all required." },
        { status: 400 },
      );
    }

    const entry: ReceiptAttendeeDirectoryEntry = await createAttendeeDirectoryEntry(
      { name, company, title },
      actor,
    );
    return NextResponse.json({ entry }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    // UNIQUE(name) violation → 409 "already registered" (friendly, actionable).
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("UNIQUE") || msg.includes("CONSTRAINT")) {
      return NextResponse.json(
        { error: "That attendee name is already registered." },
        { status: 409 },
      );
    }
    console.error("[api/receipts/attendee-directory] POST failed", error);
    return NextResponse.json(
      { error: msg || "Failed to register attendee." },
      { status: 500 },
    );
  }
}
