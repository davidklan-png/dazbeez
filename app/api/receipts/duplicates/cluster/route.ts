import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { recommendRetention } from "@/lib/receipts/duplicate-resolution-policy";
import { fetchMemberAssessment, normalizeClusterIds } from "@/lib/receipts/duplicate-purge";

// GET /api/receipts/duplicates/cluster?ids=a,b,c
// Server-computed comparison + retention recommendation as an explicit JSON DTO
// (no serialized Map). The modal renders this and runs the pure assessSelection
// on selection changes; the operator explicitly checks purge targets (none by
// default) and submits to /api/receipts/duplicates/purge. Server is
// authoritative — the client never scores.

export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    const db = getReceiptsDb();
    const rawIds =
      new URL(request.url).searchParams
        .get("ids")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    // §4: pure cluster-ID normalization (testable without Clerk/route).
    const norm = normalizeClusterIds(rawIds);
    if (!norm.ok) {
      return NextResponse.json({ error: norm.error }, { status: norm.status });
    }
    const ids = norm.ids;

    const members = [];
    for (const id of ids) {
      const rec = await fetchMemberAssessment(db, id);
      // §7: reject if any requested receipt is missing/deleted — do NOT silently
      // compare a different subset.
      if (!rec) {
        return NextResponse.json(
          { error: `Receipt ${id.slice(0, 8)} not found or deleted.` },
          { status: 404 },
        );
      }
      const reasons: string[] = [];
      if (
        rec.input.status === "reconciled" ||
        rec.amexClaim ||
        rec.exportItemsCount > 0 ||
        rec.row.status === "exported" ||
        rec.row.status === "archived"
      ) {
        reasons.push("Protected — cannot purge");
      }
      if (rec.amexClaim) reasons.push(`Registered to AMEX (${rec.amexClaim.month})`);
      if (rec.exportMonths.length) reasons.push(`Exported (${rec.exportMonths.join(",")})`);
      if (rec.businessTripIds.length) reasons.push("Business-trip linkage");
      if (rec.emailIntakePromoted) reasons.push("Email-intake promotion");
      members.push({
        // Pure input (so the modal can run assessSelection client-side):
        input: rec.input,
        // Display fields:
        captured_at: rec.row.captured_at,
        captured_by: rec.row.captured_by,
        source: rec.row.source,
        original_content_type: rec.row.original_content_type,
        original_filename: rec.row.original_filename,
        status: rec.row.status,
        attendees: rec.attendees,
        amexClaim: rec.amexClaim,
        exportMonths: rec.exportMonths,
        registrationReasons: reasons,
      });
    }

    if (members.length < 2) {
      return NextResponse.json({ error: "Fewer than 2 live receipts in the cluster." }, { status: 404 });
    }

    const recResult = recommendRetention(members.map((m) => m.input));
    // DTO: convert the recommendation's Map into arrays; do not serialize a Map.
    const recommendation = {
      retainedId: recResult.retainedId,
      retainedReasons: recResult.retainedReasons,
      conflicts: recResult.conflicts,
      requiredTransfers: recResult.requiredTransfers,
      blockReasons: recResult.blockReasons,
      assessments: members.map((m) => {
        const a = recResult.assessments.get(m.input.id)!;
        return {
          id: m.input.id,
          tier: a.tier,
          canPurge: a.canPurge,
          completenessScore: a.completeness.score,
          completedFields: a.completeness.completed,
          missingFields: a.completeness.missing,
          isRetained: m.input.id === recResult.retainedId,
        };
      }),
    };

    return NextResponse.json({ recommendation, members }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/duplicates/cluster] GET failed", error);
    return NextResponse.json({ error: "Failed to load duplicate cluster." }, { status: 500 });
  }
}
