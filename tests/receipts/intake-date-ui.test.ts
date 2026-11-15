// Rendering the actual date UI catches missing/invalid metadata and labels;
// responsive visual checks additionally use these components with compiled CSS.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EmailReceiptIntake } from "@/lib/receipts/types";
mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh() {} }) } });

export async function renderDateFixture() {
  const { InboxRow } = await import("@/components/receipts/inbox/inbox-row");
  const { SenderControls } = await import("@/components/receipts/sender-controls");
  const { ToasterProvider } = await import("@/components/ui/toaster");
  const base: EmailReceiptIntake = {
    id: "known", arrived_at: "2020-11-15T12:00:00Z", created_at: "2020-11-15T12:00:02Z", received_at: "2099-01-01T00:00:00Z",
    from_address: "fixture@example.invalid", to_address: "receipts@example.invalid", subject: "Local date fixture",
    spf_pass: 1, dkim_pass: 1, status: "pending_triage", reject_reason: "no attachment", promoted_receipt_id: null,
    attachment_r2_key: null, attachment_sha256: null, attachment_content_type: null, attachment_size_bytes: null, attachment_filename: null,
    raw_headers_json: '{"date":"Thu, 01 Jan 2099 00:00:00 +0000"}', body_text: "Receipt body", body_html: null, body_truncated: 0,
  };
  return renderToStaticMarkup(createElement(ToasterProvider, null,
    createElement("main", { className: "mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-8" },
      createElement("h1", { className: "text-xl font-bold" }, "Inbox dates — local fixtures"),
      createElement("ul", { className: "space-y-3" }, ...[
        base,
        { ...base, id: "legacy", arrived_at: null, raw_headers_json: '{"date":"Thu, 01 Jan 1900 00:00:00 +0000"}', received_at: "1900-01-01T00:00:00Z" },
        { ...base, id: "corrupt", arrived_at: "invalid", raw_headers_json: '{"date":"not-a-date"}' },
        { ...base, id: "missing", arrived_at: null, created_at: "invalid", raw_headers_json: '{"date":""}' },
      ].map(intake => createElement(InboxRow, { key: intake.id, intake }))),
      createElement(SenderControls, { initialTrusted: [], initialBlocked: [{ email: "blocked@example.invalid", blocked_by: "fixture", created_at: "2020-01-01T00:00:00Z", blocked_delivery_count: 2, latest_blocked_delivery: "2020-11-15T12:00:00Z", legacy_count: 1, unavailable_count: 1 }],
        initialUnrecognized: [{ from_address: "fixture@example.invalid", first_received: "2020-11-15T12:00:00Z", latest_received: "2020-11-16T12:00:00Z", legacy_count: 1, unavailable_count: 1, total: 4, pending: 4, promoted: 0, rejected: 0, spf_pass_any: 1, spf_fail_any: 0, dkim_pass_any: 1, dkim_fail_any: 0 },
        {from_address: "unavailable@example.invalid", first_received: null, latest_received: null, legacy_count: 1, unavailable_count: 1, total: 1, pending: 1, promoted: 0, rejected: 0, spf_pass_any: 0, spf_fail_any: 1, dkim_pass_any: 0, dkim_fail_any: 1}],
      }),
    ),
  ));
}

test("inbox/sender date UI renders known, sender, legacy, invalid and unavailable evidence honestly", async () => {
  const html = await renderDateFixture();
  for (const label of ["Worker arrival:", "Legacy processing time:", "Worker arrival unavailable", "Legacy processing time unavailable", "Sender Date:", "2099", "1900", "Sender Date invalid: not-a-date", "Sender Date unavailable (missing or empty)", "first activity", "latest activity", "legacy processing time", "time unavailable"]) assert.ok(html.includes(label), label);
  assert.ok(html.includes("first activity unavailable"));
  assert.ok(!html.includes("Invalid Date"));
});
