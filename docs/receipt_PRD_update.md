# Receipt PRD Update: Simplified Capture Flow

Use this as the injection prompt for the coding/planning agent. It is written to update the existing in-progress implementation plan, not replace it.

```markdown
Update the existing Dazbeez Receipt Module Implementation Plan to simplify the receipt image capture process.

Do not rewrite the whole plan from scratch. Apply this as a targeted plan update/diff. Preserve the existing architecture decisions: isolated receipt module, separate `RECEIPTS_DB`, separate R2 buckets, Cloudflare Access auth, route namespace `/receipts`, API namespace `/api/receipts`, and no coupling to the CRM or networking-card app.

## Goal

Simplify receipt capture by making it photo-first and metadata-later.

The capture moment should only solve one problem: prevent the receipt from being lost. Accounting metadata, AMEX/CASH classification, categories, attendees, reconciliation, and export readiness should happen later in review.

## Core Product Change

Change the capture flow from:

```text
capture photo
→ enter metadata
→ select AMEX/CASH
→ select category
→ add attendees if needed
→ save
```

to:

```text
open /receipts/capture
→ tap one large “Take Receipt Photo” button
→ native iPhone camera/file picker opens
→ photo uploads immediately
→ receipt record is created as needs_review
→ user sees “Saved. Add another?”
```

Capture must not require:
- merchant
- amount
- transaction date
- payment path
- expense type
- business purpose
- attendees
- AMEX match
- memo/comment

All of those can be optional at capture and required later only when needed for review/export.

## Replace Milestone 3 Structure

Replace the current Milestone 3 heading:

```text
Milestone 3 — Capture and Review
```

with two smaller milestones:

```text
Milestone 3A — Receipt Drop

Purpose:
Ship the fastest possible mobile capture workflow.

Files:
app/(receipt-system)/receipts/capture/page.tsx
app/api/receipts/upload/route.ts
app/api/receipts/[id]/file/route.ts
components/receipts/receipt-drop-button.tsx
components/receipts/receipt-capture-success.tsx

Behavior:
- `/receipts/capture` shows one primary action: “Take Receipt Photo”.
- Use a native file input:
  <input type="file" accept="image/*" capture="environment" />
- Do not use getUserMedia, live camera preview, scanner UI, cropping, edge detection, or composite PDF creation in v1.
- Upload immediately after photo selection.
- Create a receipt record with default metadata.
- Show a success screen with:
  - Add another receipt
  - Add details now
  - Done
- Add details now links to `/receipts/review/[id]`.
- Add another returns to `/receipts/capture`.

Default record values:
- status = "needs_review"
- payment_path = "UNKNOWN"
- expense_type = "UNKNOWN"
- source = "mobile_capture"
- captured_by = authenticated receipt actor
- capture_timestamp = current ISO timestamp
- r2_key = generated immutable R2 key
- sha256_hash = computed from uploaded file
```

Then add:

```text
Milestone 3B — Review Later

Purpose:
Complete the accounting details after capture.

Files:
app/(receipt-system)/receipts/review/page.tsx
app/(receipt-system)/receipts/review/[id]/page.tsx
app/api/receipts/[id]/route.ts
components/receipts/receipt-review-form.tsx
components/receipts/attendee-editor.tsx

Behavior:
- Review queue lists receipts with status = needs_review or incomplete.
- Review form allows editing:
  - payment_path: AMEX / CASH / DIGITAL / UNKNOWN
  - expense_type
  - transaction_date
  - merchant
  - amount_cents
  - currency
  - business_purpose
  - alcohol_present
  - notes
- Attendees are required only when expense_type is meeting or entertainment.
- Export must block meeting/entertainment receipts without attendees.
- Capture must not block on attendees.
```

## Capture UI Requirements

The capture page should be intentionally sparse.

Preferred mobile UI:

```text
Dazbeez Receipts

[ Take Receipt Photo ]

Optional:
[ AMEX ] [ CASH ]

Last saved:
Receipt saved today 14:32
Status: Needs review

[ Review receipts ]
```

Rules:
- The AMEX/CASH chips are optional.
- If the user does nothing except take a photo, the upload still succeeds.
- If a chip is selected, pass it as optional `paymentPath`.
- If no chip is selected, server stores `payment_path = "UNKNOWN"`.
- Do not show the full category list on capture.
- Do not show attendee fields on capture.
- Do not show an accounting dashboard on capture.

## Add Shortcut URLs

Support shortcut URLs for iPhone Home Screen icons:

```text
/receipts/capture
/receipts/capture?payment=AMEX
/receipts/capture?payment=CASH
/receipts/capture?mode=rapid
```

Behavior:
- `?payment=AMEX` preselects AMEX.
- `?payment=CASH` preselects CASH.
- `?mode=rapid` keeps the user in continuous capture mode:
  - after successful upload, show “Add another” as the primary action
  - preserve the previously selected payment path
  - do not force navigation to review

These shortcut URLs are convenience only. The review screen must always allow correction.

## Upload API Change

Update `app/api/receipts/upload/route.ts` requirements.

The upload endpoint should accept metadata but require only the file.

Pseudo type:

```ts
type ReceiptUploadInput = {
  file: File;
  paymentPath?: "AMEX" | "CASH" | "DIGITAL" | "UNKNOWN";
  expenseType?: string;
  note?: string;
};
```

Server defaults:

```ts
const paymentPath = input.paymentPath ?? "UNKNOWN";
const expenseType = input.expenseType ?? "UNKNOWN";
const status = "needs_review";
```

The endpoint must:
1. Enforce receipt auth.
2. Validate that a file exists.
3. Accept `image/*` for mobile capture.
4. Accept `application/pdf` for desktop digital receipt upload if already planned.
5. Reject unsupported file types.
6. Compute SHA-256.
7. Generate immutable R2 key.
8. Upload original file to `RECEIPTS_BUCKET`.
9. Insert `receipt_records` row.
10. Write audit log event `receipt.uploaded`.
11. Return `{ ok: true, receiptId, status, reviewUrl }`.

Do not require merchant, amount, date, category, or attendees in this endpoint.

## Database Implications

Keep the existing schema direction, but make sure the core receipt table allows capture-first records.

Fields that must allow NULL or UNKNOWN during capture:
- payment_path
- expense_type
- transaction_date
- merchant
- amount_cents
- currency
- business_purpose
- alcohol_present

Required at initial upload:
- id
- status
- source
- captured_by
- captured_at / capture_timestamp
- original_filename
- mime_type
- r2_key
- sha256_hash
- created_at
- updated_at

If the current schema uses CHECK constraints, include `UNKNOWN` where appropriate.

## Multi-Image Rule

Preserve the principle:

```text
one receipt = one receipt record
```

But allow future support for multiple files/images attached to one receipt record.

Do not create composite PDFs.

Add a backlog note, or schema placeholder if low-cost, for:

```text
receipt_files
  id
  receipt_id
  role: original | back | continuation | related_invoice | processed
  r2_key
  mime_type
  sha256_hash
  uploaded_at
```

If implementing `receipt_files` now would slow Milestone 3A, defer it and keep one file per receipt record for v1.

## Review and Export Rules

Move compliance enforcement to review/export.

Rules:
- Receipt upload can create incomplete records.
- Review marks records complete only after required fields are present.
- Meeting and entertainment require attendees before export.
- AMEX receipts do not need to be matched at capture.
- CASH receipts do not need amount/date at capture but must have them before export.
- Monthly export must fail or warn clearly if receipts remain incomplete.

## Update Tests

Adjust/add tests to reflect the simplified capture behavior.

Required tests:
- Upload with only file succeeds.
- Upload with no payment path stores `UNKNOWN`.
- Upload with no expense type stores `UNKNOWN`.
- Upload does not require attendees.
- Meeting/entertainment without attendees is allowed at upload but blocked at export.
- Unsupported MIME type is rejected.
- AMEX/CASH shortcut payment values are accepted.
- Invalid payment value is rejected or normalized safely.

## Update Documentation

Update `docs/receipt-module.md` and the implementation plan to explain:

```text
Capture is intentionally minimal.
Review is where accounting completeness happens.
The system optimizes for never losing receipts.
```

Include this user-facing description:

```text
The capture screen is a receipt drop box, not an accounting form.
Take the picture now; clean up the details later.
```

## Non-Goals for Capture v1

Do not implement these in the first capture milestone:
- live camera scanner
- OCR before saving
- required category selection
- required attendee entry
- cropping/deskewing
- receipt edge detection
- composite PDF generation
- AMEX reconciliation during capture
- accountant export from capture page

These can be later enhancements after the basic drop flow works reliably.

## Acceptance Criteria

Milestone 3A is complete when:

1. On iPhone, `/receipts/capture` allows taking a receipt photo with one primary button.
2. The photo uploads successfully with no required metadata.
3. A `receipt_records` row is created with `status = needs_review`.
4. Missing payment/category/accounting fields are represented as `UNKNOWN` or NULL, not as validation failures.
5. The success screen offers “Add another receipt”, “Add details now”, and “Done”.
6. `/receipts/review/[id]` can open the newly captured receipt.
7. Public marketing pages, CRM admin pages, and networking-card routes are unaffected.
8. `npm run build:cf` and `npm test` pass.
```

Suggested one-line instruction to add at the top of the plan:

```markdown
Capture principle: the receipt capture page is a drop box, not an accounting form. Save the image first; require accounting completeness later during review/export.
```
