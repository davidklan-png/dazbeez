# Receipt Review Feature Requests

## Context

The Dazbeez receipt module is now deployed and working in production:

- Cloudflare Access authentication works.
- iPhone receipt capture works.
- Receipt records are created.
- Receipt review pages open.
- Receipt image preview now loads without Cloudflare Worker 1102 errors.
- R2 file preview uses the streamed file route successfully.

These feature requests are the next iteration for improving the receipt capture and review workflow.

---

## Feature Request 1: Add Capture Acknowledgment Message

### Problem

After taking a receipt photo on iPhone, the user needs immediate confirmation that something happened. The current behavior can feel ambiguous because the page may transition without a clear acknowledgment.

### Goal

After a photo is selected or captured, the UI should show a clear acknowledgment and upload progress state.

### Requirements

When a user takes or selects a receipt photo:

1. Immediately show an acknowledgment message such as:

   ```text
   Photo captured. Uploading receipt…
   ```

2. Disable the capture button while upload is in progress.

3. After upload succeeds, show:

   ```text
   Receipt saved.
   ```

4. The success screen should offer:

   ```text
   Add another receipt
   Add details now
   Done
   ```

5. If upload fails, show a visible error message:

   ```text
   Upload failed. Please try again.
   ```

6. The error should include the HTTP status and server message if available.

7. Do not silently fail after photo selection.

### Suggested UI States

```text
Initial:
[ Take Receipt Photo ]

After file selection:
Photo captured. Uploading receipt…

Success:
Receipt saved.
[ Add another receipt ]
[ Add details now ]
[ Done ]

Failure:
Upload failed. Please try again.
[ Try again ]
```

### Acceptance Criteria

- On iPhone, the user sees immediate feedback after taking a photo.
- The user always sees one of: uploading, saved, or error.
- No silent no-op after capture.
- Repeated capture still works after success or failure.
- The same file can be retried if upload fails.

---

## Feature Request 2: Zoomable Receipt Image Preview

### Problem

The receipt image preview works, but users need to zoom in to verify receipt details such as merchant, date, tax, and amount.

### Goal

Allow the user to zoom and pan the receipt image in the review page.

### Target Areas

Likely files:

```text
app/(receipt-system)/receipts/review/[id]/page.tsx
components/receipts/receipt-image-viewer.tsx
```

Create a new client component if needed:

```text
components/receipts/receipt-image-viewer.tsx
```

### Requirements

1. Display the receipt using the existing streamed file URL:

   ```text
   /api/receipts/${receipt.id}/file
   ```

2. Keep the image as a normal `<img>` source.

3. Do not fetch image bytes in JavaScript.

4. Do not convert the image to base64.

5. Do not put the file bytes into React state.

6. Add zoom controls:

   ```text
   Zoom out
   Zoom in
   Reset
   Fit to screen / fit to width, if easy
   ```

7. Support iPhone-friendly zooming if feasible.

8. Support panning or scrolling when zoomed.

9. Use CSS transforms for v1.

10. Do not use canvas rendering for v1.

### Suggested UI

```text
Receipt Preview

[ - ] [ 100% ] [ + ] [ Reset ]

[ scrollable image area ]
```

### Suggested Rendering Pattern

```tsx
<div className="max-h-[70vh] overflow-auto rounded-xl border bg-gray-50 p-2">
  <img
    src={`/api/receipts/${receipt.id}/file`}
    alt="Receipt preview"
    className="mx-auto h-auto max-w-full object-contain"
  />
</div>
```

For zooming, the image viewer can apply CSS transform state:

```tsx
style={{
  transform: `scale(${zoom})`,
  transformOrigin: "top center",
}}
```

### Acceptance Criteria

- User can zoom into a receipt image enough to read details.
- User can reset zoom.
- Image remains scrollable or pannable when zoomed.
- Refreshing the review page does not trigger Cloudflare Error 1102.
- The image is never converted to a base64 data URL.

---

## Feature Request 3: AI/OCR Extraction in Review

### Problem

Manual entry of receipt fields is slow. The system should help by extracting receipt details from the image, but the user should still confirm and edit before saving.

### Goal

Add an AI/OCR extraction button to the review page that pre-fills receipt fields.

### Target Areas

Likely files:

```text
lib/receipts/extraction.ts
app/api/receipts/[id]/extract/route.ts
app/(receipt-system)/receipts/review/[id]/page.tsx
components/receipts/receipt-review-form.tsx
```

### User Flow

```text
Open receipt review page
↓
Click "Extract details with AI"
↓
System shows "Extracting…"
↓
Fields are pre-filled with extracted values
↓
User confirms or edits values
↓
User clicks "Save & mark reviewed"
```

### Requirements

1. Add a button on the review page:

   ```text
   Extract details with AI
   ```

2. Extraction must be manually triggered.

3. Do not run extraction automatically on page load.

4. When clicked, call:

   ```text
   POST /api/receipts/${id}/extract
   ```

5. Show loading state:

   ```text
   Extracting…
   ```

6. Return structured JSON.

7. Pre-fill empty form fields.

8. If a field already has a user-entered value, do not silently overwrite it.

9. Show suggestions for conflicting values.

10. Keep all values editable.

11. User must still click:

   ```text
   Save & mark reviewed
   ```

12. Extraction failure should show a visible error but leave manual review usable.

### Suggested Extraction Result Shape

```ts
type ReceiptExtractionResult = {
  transactionDate?: string; // YYYY-MM-DD
  merchant?: string;
  amountCents?: number;
  currency?: "JPY" | "USD" | string;
  taxAmountCents?: number;
  paymentPath?: "AMEX" | "CASH" | "DIGITAL" | "UNKNOWN";
  expenseType?: string;
  alcoholPresent?: boolean | null;
  businessPurposeSuggestion?: string;
  confidence?: {
    transactionDate?: number;
    merchant?: number;
    amountCents?: number;
    currency?: number;
    taxAmountCents?: number;
    expenseType?: number;
  };
  rawText?: string;
  warnings?: string[];
};
```

### Suggested AI Prompt

```text
You are extracting accounting fields from a receipt image for Dazbeez.

Return only valid JSON. No markdown.

Extract:
- transactionDate in YYYY-MM-DD
- merchant
- total amount as amountCents
- currency, default JPY if the receipt is Japanese and currency is not explicit
- taxAmountCents if shown
- likely expenseType from: meeting_no_alcohol, entertainment_alcohol, transportation, books, research, insurance, misc, unknown
- alcoholPresent true/false/null
- any warnings

Rules:
- Do not guess attendees.
- Do not guess business purpose beyond a short suggestion.
- If uncertain, use null and include a warning.
- Amounts must be integers in minor units.
```

### Important Performance Rule

Extraction must not run on page load.

Reasons:

- Avoid repeated AI calls on refresh.
- Avoid unnecessary cost.
- Avoid Cloudflare Worker resource pressure.
- Preserve the human-confirm-before-save workflow.

### Audit Log Events

Add audit events:

```text
receipt.extraction_requested
receipt.extraction_completed
receipt.extraction_failed
receipt.updated
receipt.reviewed
```

### Acceptance Criteria

- Review page has an "Extract details with AI" button.
- Extraction runs only after button click.
- Empty fields are pre-filled from extraction.
- Existing user-entered values are not silently overwritten.
- User can edit all fields after extraction.
- User must still save manually.
- Extraction errors are visible and non-blocking.

---

## Feature Request 4: Delete from Review List

### Problem

Test receipts, duplicate captures, bad images, and accidental uploads need to be removable from the review queue.

### Goal

Add a delete option to the review list.

### Target Areas

Likely files:

```text
app/(receipt-system)/receipts/review/page.tsx
app/api/receipts/[id]/route.ts
lib/receipts/db.ts
lib/receipts/audit.ts
```

### UI Requirements

Each receipt row or card in `/receipts/review` should include:

```text
Delete
```

### User Flow

```text
Open /receipts/review
↓
Click Delete on a receipt
↓
Confirm deletion
↓
Receipt disappears from default review list
```

### Confirmation Message

```text
Delete this receipt? This removes it from review and prevents it from being included in exports.
```

### Data Behavior

Prefer soft delete, not hard delete.

If needed, add a migration:

```text
db/receipts/0003_soft_delete.sql
```

Suggested fields:

```sql
ALTER TABLE receipt_records ADD COLUMN deleted_at TEXT;
ALTER TABLE receipt_records ADD COLUMN deleted_by TEXT;
ALTER TABLE receipt_records ADD COLUMN delete_reason TEXT;
```

On delete:

```text
status = "deleted"
deleted_at = current ISO timestamp
deleted_by = authenticated receipt actor
delete_reason = optional reason
```

### API Requirements

Add or complete:

```text
DELETE /api/receipts/[id]
```

Behavior:

1. Auth required.
2. If receipt is already finalized/exported, block delete unless a future explicit admin override exists.
3. Soft-delete normal records.
4. Do not immediately delete the R2 original.
5. Exclude deleted receipts from default review/list/export queries.
6. Write audit event:

   ```text
   receipt.deleted
   ```

### Acceptance Criteria

- Review list shows a Delete action.
- User can delete a newly captured test receipt.
- Deleted receipt disappears from default review list.
- Deleted receipt is excluded from exports.
- R2 original remains stored for audit/recovery.
- Audit log records who deleted it and when.

---

## Tests to Add or Update

### Capture Acknowledgment

- Photo selection shows "Photo captured. Uploading receipt…"
- Successful upload shows "Receipt saved."
- Failed upload shows visible error.
- Capture button is disabled while uploading.
- File input resets after upload attempt.

### Image Viewer

- Viewer renders streamed image URL.
- Zoom in/out/reset controls work.
- No base64/data URL usage.
- Refreshing review page does not buffer image bytes.

### AI/OCR Extraction

- Extract button calls `/api/receipts/:id/extract`.
- Extraction does not run on page load.
- Loading state appears.
- Successful extraction pre-fills empty fields.
- Existing user values are not silently overwritten.
- Extraction failure shows visible error.

### Delete

- Review list renders Delete action.
- Confirmation appears before deletion.
- Confirmed delete calls `DELETE /api/receipts/:id`.
- Deleted receipt disappears from list.
- API soft-deletes and writes audit log.
- Deleted receipts are excluded from export.

---

## Build and Verification

Run:

```bash
npm test
npm run build:cf
```

Then verify in production:

```text
1. Open /receipts/capture on iPhone.
2. Take a receipt photo.
3. Confirm acknowledgment appears immediately.
4. Confirm success screen appears after upload.
5. Open /receipts/review.
6. Open the captured receipt.
7. Zoom into the receipt image.
8. Run AI extraction.
9. Confirm extracted values pre-fill the form.
10. Edit values if necessary.
11. Save and mark reviewed.
12. Delete a test receipt from the review list.
13. Confirm deleted receipt disappears from default review.
14. Confirm private/incognito access still triggers Cloudflare Access.
```

---

## Non-Goals for This Iteration

Do not implement:

- Automatic extraction on page load
- Automatic final save without user confirmation
- Hard deletion of R2 originals
- Composite PDF generation
- Canvas-based image processing
- OCR during initial upload
- AMEX reconciliation changes
- Accountant export redesign

---

## Summary

This iteration should make the review process faster and clearer:

```text
Capture photo
→ see acknowledgment
→ receipt saved
→ open review
→ zoom into image
→ extract details with AI
→ confirm/edit
→ save
→ delete mistakes from review list
```

The system should continue to optimize for:

```text
Save the receipt first.
Review and confirm details later.
Never silently fail.
```
