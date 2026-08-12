import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { updateAttendeeDirectoryEntry } from "@/lib/receipts/db";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";

// PATCH company/title for an attendee_directory entry. The name (identity / join
// key) is NOT editable — renaming would orphan receipt_attendees (free-text, no
// FK) and drift sealed-vs-unsealed resolution. See updateAttendeeDirectoryEntry.

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id: idStr } = await params;
    const id = Number(idStr);
    if (!Number.isInteger(id) || id < 1) {
      return NextResponse.json({ error: "Invalid entry id." }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      company?: unknown;
      title?: unknown;
    };
    const company = typeof body.company === "string" ? body.company.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!company || !title) {
      return NextResponse.json(
        { error: "company and title are both required." },
        { status: 400 },
      );
    }

    const entry: ReceiptAttendeeDirectoryEntry = await updateAttendeeDirectoryEntry(
      id,
      { company, title },
      actor,
    );
    return NextResponse.json({ entry }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("not found")) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    console.error("[api/receipts/attendee-directory/[id]] PATCH failed", error);
    return NextResponse.json(
      { error: msg || "Failed to update attendee." },
      { status: 500 },
    );
  }
}
