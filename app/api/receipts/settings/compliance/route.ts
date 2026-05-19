import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  getComplianceSettings,
  updateComplianceSettings,
} from "@/lib/receipts/settings";
import { createAuditEntry } from "@/lib/receipts/audit";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import type { ComplianceSettings } from "@/lib/receipts/types";

export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    const settings = await getComplianceSettings();
    return NextResponse.json({ settings }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/compliance] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load settings." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const body = (await request.json()) as Partial<ComplianceSettings>;

    if (
      body.retention_years !== undefined &&
      (typeof body.retention_years !== "number" ||
        body.retention_years < 1 ||
        body.retention_years > 100)
    ) {
      return NextResponse.json(
        { error: "retention_years must be between 1 and 100." },
        { status: 400 },
      );
    }
    if (
      body.statement_expected_day !== undefined &&
      (typeof body.statement_expected_day !== "number" ||
        body.statement_expected_day < 1 ||
        body.statement_expected_day > 31)
    ) {
      return NextResponse.json(
        { error: "statement_expected_day must be 1-31." },
        { status: 400 },
      );
    }

    const settings = await updateComplianceSettings(body, actor);

    await createAuditEntry(getReceiptsDb(), {
      actor,
      action: "settings.updated",
      objectType: "compliance_settings",
      objectId: "global",
      newValueJson: JSON.stringify(body),
    });

    return NextResponse.json({ settings }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/compliance] PATCH failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Save failed." },
      { status: 500 },
    );
  }
}
