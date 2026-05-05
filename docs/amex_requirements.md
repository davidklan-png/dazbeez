# AMEX / Netアンサー Statement Import Requirements

## Purpose

Add a reliable AMEX statement-import workflow to the Dazbeez receipt module.

The AMEX statement is downloaded manually from Netアンサー as a CSV file, uploaded into the receipt system, parsed into statement line items, saved as an original artifact, and reconciled against receipt records.

This workflow supports:

- AMEX statement-first reconciliation.
- Expense-category tagging for every statement line.
- Receipt linking where a receipt exists.
- Attendee-list attachment for meeting and entertainment expenses.
- Business Trip reports for multiple charges outside Tokyo.
- Dashboard alerts when a monthly statement should be available but has not been uploaded.

---

## Source System

### Netアンサー

Netアンサー is the source for セゾンプラチナビジネス・アメリカンエキスプレスカード statement CSV files.

Official Netアンサー information / login page:

```text
https://www.saisoncard.co.jp/customer-support/netanswer/
```

User-facing dashboard link label:

```text
Open Netアンサー login
```

Recommended UI copy:

```text
Download the AMEX CSV from Netアンサー, then upload it here.
```

### Availability Rule

セゾン’s FAQ indicates that Web明細 can be downloaded as PDF or CSV from Netアンサー / セゾンPortal, with up to 15 months of confirmed statements available, and that the statement for a billing month can be downloaded from the 18th of the prior month.

Implementation rule:

```text
For statement month YYYY-MM, expected_ready_date = YYYY-MM-18 minus one calendar month.
```

Examples:

```text
2026-05 statement → expected ready from 2026-04-18
2026-06 statement → expected ready from 2026-05-18
```

Add a dashboard alert if the statement is expected to be ready but no AMEX CSV artifact has been uploaded for that statement month.

---

## Uploaded CSV Analyzed

Uploaded file:

```text
SAISON_2605.csv
```

Detected encoding:

```text
CP932 / Shift-JIS-compatible Japanese CSV
```

Do not assume UTF-8.

### High-Level Structure

The CSV has:

1. Three metadata rows.
2. One blank row.
3. One header row.
4. One or more cardholder sections.
5. Transaction rows under each cardholder.
6. Subtotal and total rows per cardholder.

### Metadata Rows

Observed rows:

```csv
カード名称,セゾンプラチナビジネス・アメリカンエキスプレスカード
お支払日,2026/05/07
今回ご請求額,0000192265
```

Parsed metadata:

```text
card_name = セゾンプラチナビジネス・アメリカンエキスプレスカード
payment_due_date = 2026-05-07
statement_total_amount = 192265
```

### Header Row

Observed header:

```csv
利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考
```

Map to canonical fields:

| CSV header | Canonical field |
|---|---|
| 利用日 | transaction_date |
| ご利用店名及び商品名 | merchant_name |
| 本人・家族区分 | cardholder_flag |
| 支払区分名称 | payment_type |
| 締前入金区分 | prepayment_flag |
| 利用金額 | amount_cents |
| 備考 | memo |

### Cardholder Section Rows

Observed examples:

```csv
,ご利用者名:村上 多寿子     様,,,,,
,ご利用者名:クランデイビツト ジヨン         様,1,,,,
```

Parser behavior:

- A row where column 2 starts with `ご利用者名:` starts a new cardholder section.
- Strip the prefix `ご利用者名:`.
- Trim whitespace.
- Strip trailing `様`.
- Assign this cardholder name to all subsequent transaction rows until the next cardholder section.

Canonical field:

```text
cardholder_name
```

### Transaction Rows

A transaction row is any row where:

```text
column 1 matches YYYY/MM/DD
```

Observed example:

```csv
2026/03/12,HUB 東京オペラシティ店,1,1回,,1515,
```

Parse to:

```json
{
  "transaction_date": "2026-03-12",
  "merchant_name": "HUB 東京オペラシティ店",
  "cardholder_name": "クランデイビツト ジヨン",
  "cardholder_flag": "1",
  "payment_type": "1回",
  "prepayment_flag": "",
  "amount_cents": 1515,
  "currency": "JPY",
  "memo": ""
}
```

### Subtotal / Total Rows

Observed:

```csv
,【小計】,,,,77016,
,【合計】,,,,77016,
```

Parser behavior:

- Do not import `【小計】` or `【合計】` as statement lines.
- Use these rows only for validation if helpful.
- Validate the sum of transaction rows per cardholder against subtotal rows where practical.
- Validate the sum of all transaction rows against `今回ご請求額`.

### Parsed Sample Summary

From `SAISON_2605.csv`:

| Metric | Value |
|---|---:|
| Statement total | ¥192,265 |
| Parsed transaction count | 25 |
| Parsed transaction sum | ¥192,265 |
| Cardholder sections | 2 |

By cardholder:

| Cardholder | Count | Sum |
|---|---:|---:|
| 村上 多寿子 | 6 | ¥77,016 |
| クランデイビツト ジヨン | 19 | ¥115,249 |

Validation requirement:

```text
parsed_transaction_sum must equal statement_total_amount.
```

If it does not match, the import should fail or return a blocking validation error.

---

## Data Model Requirements

### Existing / Expected Table

Use or extend:

```text
amex_statement_lines
```

Each imported transaction row should become one line item.

Required fields:

```text
id
statement_artifact_id
statement_month
payment_due_date
card_name
cardholder_name
cardholder_flag
transaction_date
merchant_name
payment_type
prepayment_flag
amount_cents
currency
memo
raw_csv_line_number
raw_csv_row_json
source_file_sha256
imported_at
matched_receipt_id
match_status
expense_category
category_status
business_trip_id
business_trip_status
created_at
updated_at
```

Recommended `match_status` values:

```text
unmatched
matched
ignored
needs_review
```

Recommended `category_status` values:

```text
uncategorized
suggested
confirmed
```

Recommended `business_trip_status` values:

```text
not_applicable
candidate
confirmed
excluded
```

### New Statement Artifact Table

Add if not already present:

```text
amex_statement_artifacts
```

Purpose: preserve the original uploaded CSV and import metadata.

Suggested fields:

```text
id
statement_month
payment_due_date
card_name
original_filename
r2_key
mime_type
encoding
sha256_hash
file_size_bytes
uploaded_by
uploaded_at
import_status
row_count
transaction_count
statement_total_amount_cents
parsed_total_amount_cents
validation_errors_json
created_at
updated_at
```

Recommended `import_status` values:

```text
uploaded
parsed
failed
replaced
archived
```

### R2 Artifact Storage

Save the original CSV artifact in R2.

Suggested key pattern:

```text
amex-statements/{YYYY-MM}/{artifactId}-{safeOriginalFilename}
```

Example:

```text
amex-statements/2026-05/123-SAISON_2605.csv
```

Do not discard the uploaded CSV after parsing.

---

## Idempotency and Duplicate Handling

### File-Level Duplicate Detection

Compute SHA-256 of the uploaded file.

If the same `sha256_hash` has already been imported:

- Do not create duplicate line items.
- Return the existing artifact and import result.
- Show a user-friendly message:

```text
This AMEX statement file has already been uploaded.
```

### Line-Level Duplicate Key

Use a deterministic import key to avoid duplicate lines.

Suggested unique key fields:

```text
statement_month
cardholder_name
transaction_date
merchant_name
amount_cents
raw_csv_line_number
source_file_sha256
```

If the provider later adds a unique transaction ID, use that instead.

### Replacement Behavior

If a corrected CSV for the same statement month is uploaded:

- Do not silently replace existing data.
- Show a confirmation:

```text
A statement for 2026-05 already exists. Replace it?
```

If confirmed:

- Mark previous artifact `import_status = replaced`.
- Soft-delete or supersede previous statement lines.
- Import the new artifact.
- Keep previous original CSV artifact for audit.

---

## Parser Requirements

### Encoding

Parser must support:

```text
cp932
shift_jis
utf-8-sig
utf-8
```

Detection strategy:

1. Try UTF-8 with BOM.
2. Try UTF-8.
3. Try CP932.
4. Try Shift-JIS.
5. If all fail, return visible import error.

For Netアンサー files, expect CP932/Shift-JIS-compatible encoding.

### Date Parsing

Input:

```text
YYYY/MM/DD
```

Output:

```text
YYYY-MM-DD
```

### Amount Parsing

Input examples:

```text
0000192265
2200
1515
```

Rules:

- Strip commas if present.
- Parse as integer JPY amount.
- Store as integer minor units in `amount_cents`.
- For JPY, the minor unit is effectively yen, but keep existing field name `amount_cents` for consistency.

### Rows to Ignore

Ignore:

```text
blank rows
header rows
cardholder section rows
【小計】
【合計】
```

### Validation

Import should validate:

1. Required metadata exists:
   - `カード名称`
   - `お支払日`
   - `今回ご請求額`

2. Header row exists and matches expected columns.

3. At least one transaction row exists.

4. Sum of imported transaction amounts equals `今回ご請求額`.

5. Optional: cardholder subtotal rows match transaction sums per section.

If validation fails:

- Save the artifact with `import_status = failed`.
- Save validation errors.
- Do not create active statement lines.
- Show a visible error to the user.

---

## UI Requirements

### AMEX Import Page

Route:

```text
/receipts/amex
```

Add or confirm the page includes:

```text
Import AMEX CSV
Statement month selector
File picker
Upload button
Link to Netアンサー login
Import result summary
```

Netアンサー login link:

```text
https://www.saisoncard.co.jp/customer-support/netanswer/
```

Suggested copy:

```text
Download the CSV from Netアンサー Web明細, then upload it here.
```

### Upload Result Summary

After upload, show:

```text
Statement month: 2026-05
Payment due date: 2026-05-07
Card: セゾンプラチナビジネス・アメリカンエキスプレスカード
Rows imported: 25
Total: ¥192,265
Status: Parsed successfully
```

### Error Messages

Examples:

```text
Could not read this CSV. Netアンサー files are usually CP932/Shift-JIS. Please upload the original CSV file.
```

```text
The parsed total ¥190,000 does not match the statement total ¥192,265. No line items were imported.
```

```text
This AMEX statement has already been uploaded.
```

---

## Dashboard Alert Requirement

### Goal

Show an alert on the receipt dashboard when an AMEX monthly statement should be ready but has not been uploaded.

### Readiness Rule

A statement for month `YYYY-MM` is considered ready on:

```text
the 18th day of the previous calendar month
```

Examples:

| Statement month | Ready date |
|---|---|
| 2026-05 | 2026-04-18 |
| 2026-06 | 2026-05-18 |
| 2026-07 | 2026-06-18 |

### Dashboard Logic

For each expected statement month:

```text
if today >= expected_ready_date
and no amex_statement_artifact exists for statement_month
and alert not dismissed
then show alert
```

### Alert UI

Suggested text:

```text
AMEX statement for 2026-05 should now be available in Netアンサー, but it has not been uploaded yet.
```

Buttons:

```text
Open Netアンサー
Upload AMEX CSV
Dismiss for now
```

### Dismissal

Dismissal should be temporary and month-specific.

Suggested table:

```text
dashboard_alert_dismissals
```

Fields:

```text
id
alert_type
alert_key
dismissed_by
dismissed_at
expires_at
created_at
```

For AMEX:

```text
alert_type = "amex_statement_missing"
alert_key = "2026-05"
expires_at = expected_ready_date + 7 days
```

If the statement is still missing after expiration, the alert should return.

---

## Categorization Requirement

Reports require every AMEX line item to be tagged with an expense category and receipt status.

### Required Per-Line Fields

Each statement line should show and persist:

```text
expense_category
matched_receipt_id
receipt_status
category_status
notes
```

Expense category values should align with existing receipt categories:

```text
meeting_no_alcohol
entertainment_alcohol
transportation
books
research
insurance
software
telecom
office_supplies
travel
business_trip
misc
unknown
```

Default:

```text
unknown
```

A line item is not report-ready until:

```text
expense_category != unknown
```

### Receipt Linking

Each AMEX line should have one of:

```text
matched_receipt_id = receipt id
receipt_status = matched
```

or:

```text
matched_receipt_id = null
receipt_status = missing_receipt
```

Allow explicit no-receipt justification:

```text
receipt_status = no_receipt_required
receipt_missing_reason = <user-entered reason>
```

Suggested `receipt_status` values:

```text
missing_receipt
matched
no_receipt_required
receipt_not_available
```

### Report Readiness Rule

An AMEX line is report-ready when:

```text
expense_category is confirmed
AND receipt_status is not missing_receipt
AND if category is meeting_no_alcohol or entertainment_alcohol, attendees are complete
AND if business_trip_status is candidate, trip assignment is resolved
```

---

## Attendee Requirement

Meeting and entertainment expenses require attendees.

Categories requiring attendees:

```text
meeting_no_alcohol
entertainment_alcohol
```

For AMEX statement lines in those categories:

- Use attendees from the matched receipt if available.
- If no matched receipt exists, allow attendees to be attached directly to the AMEX line.
- Export reports should include attendee details.

### Suggested Table

Add if needed:

```text
amex_line_attendees
```

Fields:

```text
id
amex_statement_line_id
attendee_name
company
relationship
is_dazbeez_employee
notes
created_at
updated_at
```

If a receipt is matched and already has `receipt_attendees`, reports should prefer receipt attendees but may display them in the AMEX report context.

### Export Format

For each meeting/entertainment line, append attendee list:

```text
Attendees: David Klan (Dazbeez), Jane Smith (Client Co.), ...
```

If attendees are missing, the report should flag:

```text
Needs attendees
```

and prevent final monthly export unless overridden by an explicit admin override.

---

## Business Trip Report Requirement

Business Trip reports must be produced for multiple charges outside Tokyo.

### Goal

Detect clusters of AMEX charges outside Tokyo and group them into candidate business trips for review.

### Candidate Detection

A business trip candidate should be created when:

```text
two or more charges occur outside Tokyo
within a configurable date window
for the same cardholder
```

Default date window:

```text
7 days
```

### Outside Tokyo Detection

Use merchant location signals from:

1. Merchant string contains a prefecture/city outside Tokyo, e.g.
   - 神奈川県 横浜市
   - 大阪
   - 京都
   - 福岡
   - 札幌
   - 名古屋
   - 仙台
   - Hiroshima / Osaka / Kyoto / Yokohama / etc.

2. Expense category is travel or transportation and location is not Tokyo.

3. User manually marks line as outside Tokyo.

Tokyo strings that should generally not trigger outside-Tokyo:

```text
東京都
東京
新宿
渋谷
中野
東中野
港区
東京オペラシティ
```

Important: this should be treated as a candidate-detection aid, not final classification.

### Candidate Trip Fields

Suggested table:

```text
business_trip_reports
```

Fields:

```text
id
trip_name
cardholder_name
start_date
end_date
primary_location
status
purpose
created_at
updated_at
```

Suggested child table:

```text
business_trip_report_lines
```

Fields:

```text
id
business_trip_report_id
amex_statement_line_id
created_at
```

Suggested status values:

```text
candidate
confirmed
rejected
exported
```

### Review UI

Add a business trip review panel:

```text
/receipts/amex
or
/receipts/reconcile
```

For each candidate:

```text
Business Trip Candidate
Cardholder: David Klan
Dates: 2026-03-10 to 2026-03-17
Location: Kanagawa / Yokohama
Lines:
- 2026-03-10 ピーシーデポ バリューパック -神奈川県 横浜市 ¥21,450
- 2026-03-16 JTB KANAGAWANISHI ¥15,000
Actions:
[ Confirm trip ] [ Reject ] [ Edit purpose ]
```

### Export

Business Trip report should include:

```text
trip name
cardholder
start date
end date
primary location
business purpose
included charges
total amount
linked receipts
attendees where applicable
```

### Important Note from Sample CSV

The uploaded sample contains an outside-Tokyo line:

```text
2026-03-10 ピーシーデポ バリューパック -神奈川県 横浜市 ¥21,450
```

However, one outside-Tokyo line alone should not create a trip report. It may be marked as:

```text
business_trip_status = candidate_signal
```

A business trip candidate should require multiple related outside-Tokyo charges unless manually created by the user.

---

## Reconciliation Requirements

### Matching AMEX Lines to Receipts

The system should match AMEX lines against receipt records using:

```text
amount
transaction_date ± configurable tolerance
merchant similarity
payment_path = AMEX
cardholder / captured_by if available
```

Default date tolerance:

```text
±3 days
```

### Matching Confidence

Suggested statuses:

```text
auto_matched
possible_match
manual_match
unmatched
```

Do not auto-finalize low-confidence matches.

### Manual Review

The reconciliation UI should let the user:

```text
link receipt
unlink receipt
change category
mark receipt not available
add attendees
assign to business trip
confirm report readiness
```

---

## Report Requirements

Monthly AMEX reports require:

1. Every line item from the uploaded statement.
2. Expense category for every line.
3. Receipt link or explicit missing-receipt reason.
4. Attendees for meeting and entertainment.
5. Business trip grouping for confirmed trips.
6. Statement artifact reference and SHA-256.
7. Import validation summary.

### Monthly AMEX Report Columns

Recommended columns:

```text
statement_month
payment_due_date
transaction_date
cardholder_name
merchant_name
amount_cents
currency
expense_category
receipt_status
receipt_id
attendees
business_trip_id
business_trip_name
business_trip_location
business_purpose
notes
```

### Export Blocking Rules

Block final monthly export if:

```text
any AMEX line has expense_category = unknown
any AMEX line has receipt_status = missing_receipt without reason
any meeting/entertainment line lacks attendees
any business_trip candidate is unresolved
statement total validation failed
```

---

## Coding Agent Tasks

### Task 1: Add AMEX Statement Artifact Persistence

Implement:

```text
amex_statement_artifacts
R2 upload of original CSV
SHA-256 duplicate detection
artifact metadata persistence
```

### Task 2: Implement Netアンサー CSV Parser

Parser must:

```text
decode CP932/Shift-JIS
read metadata rows
detect header row
track cardholder sections
import transaction rows
skip subtotal/total rows
validate totals
return structured rows and validation summary
```

### Task 3: Implement AMEX Import API

Route:

```text
POST /api/receipts/amex/import
```

Behavior:

```text
auth required
accept CSV file and statement_month
save original artifact to R2
parse CSV
validate totals
insert artifact row
insert statement line rows
return import summary
```

### Task 4: Add Dashboard Missing Statement Alert

Implement dashboard logic:

```text
expected_ready_date = statement_month minus one month, day 18
if ready and missing, show alert
```

Alert buttons:

```text
Open Netアンサー
Upload AMEX CSV
Dismiss for now
```

### Task 5: Add Line-Item Categorization UI

On AMEX review/reconciliation page, each statement line must allow:

```text
category selection
receipt matching
receipt missing reason
attendee entry when meeting/entertainment
business trip assignment
```

### Task 6: Add Business Trip Candidate Detection

Implement:

```text
outside-Tokyo signal detection
multi-charge clustering by cardholder/date window
candidate trip review
confirmed trip report export
```

### Task 7: Update Monthly Export

Monthly export must include:

```text
all AMEX statement lines
categories
receipt links/statuses
attendees
business trip grouping
statement artifact hash
validation summary
```

---

## Acceptance Criteria

1. User can upload `SAISON_2605.csv`.
2. System detects CP932 encoding and parses it correctly.
3. System saves the original CSV artifact to R2.
4. System creates one AMEX statement artifact record.
5. System imports 25 line items.
6. Parsed total equals ¥192,265.
7. Dashboard shows missing statement alert when expected statement month has not been uploaded.
8. Dashboard alert includes a link to Netアンサー.
9. Every AMEX line can be categorized.
10. Every AMEX line can be linked to a receipt or marked with a missing-receipt reason.
11. Meeting and entertainment lines require attendee list before export.
12. Business trip candidate detection identifies multiple outside-Tokyo charges for review.
13. One outside-Tokyo line alone does not automatically create a business trip report.
14. Monthly AMEX export blocks when categories, receipts, attendees, or business-trip decisions are incomplete.
15. `npm test` passes.
16. `npm run build:cf` passes.

---

## Source Notes

Official references used for these requirements:

```text
Netアンサー information / login:
https://www.saisoncard.co.jp/customer-support/netanswer/

Web明細 PDF/CSV download FAQ:
https://faq.saisoncard.co.jp/saison/detail?id=1970
```
