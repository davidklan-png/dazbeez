import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  getComplianceSettings,
  updateComplianceSettings,
} from "@/lib/receipts/settings";
import { createAuditEntry } from "@/lib/receipts/audit";
import { resolveNotificationRecipient } from "@/lib/receipts/notify";
import { getAccountantEmail, getReceiptsDb } from "@/lib/cloudflare-runtime";
import type { ComplianceSettings } from "@/lib/receipts/types";

// Effective notification recipient: the stored Settings value if set, else the
// ACCOUNTANT_EMAIL fallback, else null. Surfaced on GET/PATCH so the form can
// show what finalize will actually use without guessing client-side.
function resolveEffectiveRecipient(settings: ComplianceSettings) {
  return resolveNotificationRecipient(
    settings.notification_recipient,
    getAccountantEmail(),
  );
}

export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    const settings = await getComplianceSettings();
    return NextResponse.json(
      { settings, effectiveRecipient: resolveEffectiveRecipient(settings) },
      { status: 200 },
    );
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

    if (
      body.notification_recipient !== undefined &&
      body.notification_recipient !== "" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.notification_recipient)
    ) {
      return NextResponse.json(
        { error: "notification_recipient must be a valid email address." },
        { status: 400 },
      );
    }

    const before = await getComplianceSettings();
    const settings = await updateComplianceSettings(body, actor);

    await createAuditEntry(getReceiptsDb(), {
      actor,
      action: "settings.updated",
      objectType: "compliance_settings",
      objectId: "global",
      newValueJson: JSON.stringify(body),
    });

    if (
      body.notification_recipient !== undefined &&
      body.notification_recipient !== before.notification_recipient
    ) {
      await createAuditEntry(getReceiptsDb(), {
        actor,
        action: "settings.notification_recipient_changed",
        objectType: "compliance_settings",
        objectId: "global",
        oldValueJson: JSON.stringify({ notification_recipient: before.notification_recipient }),
        newValueJson: JSON.stringify({ notification_recipient: body.notification_recipient }),
      });
    }

    return NextResponse.json(
      { settings, effectiveRecipient: resolveEffectiveRecipient(settings) },
      { status: 200 },
    );
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
