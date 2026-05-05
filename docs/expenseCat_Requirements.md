# Expense Category Requirements

## Purpose

Maintain a canonical Japanese expense category master list for the Dazbeez receipt and AMEX statement workflows.

These categories must be registered to:

- AMEX statement line items
- Receipt records, where available
- Monthly AMEX reports
- Receipt reports
- Business Trip reports
- Accountant exports

Each category must have:

- Stable internal code
- Japanese label
- English translation
- Attendee requirement flag
- Business trip eligibility flag, where applicable

The category list should be maintained in the system, not hard-coded separately in multiple UI components.

---

## Canonical Expense Category Master List

Seed this exact list:

| Code | Japanese | English | Requires Attendees | Default Business Trip Eligible |
|---|---|---|---:|---:|
| `employee_welfare` | 福利厚生費 | Employee welfare expenses | false | false |
| `advertising_promotion` | 広告宣伝費 | Advertising and promotion expenses | false | false |
| `entertainment` | 交際費 | Entertainment expenses | true | false |
| `meeting` | 会議費 | Meeting expenses | true | false |
| `travel_transportation` | 旅費交通費 | Travel and transportation expenses | false | true |
| `communications` | 通信費 | Communications expenses | false | false |
| `sales_commissions` | 販売手数料 | Sales commissions | false | false |
| `supplies` | 消耗品費 | Supplies and consumables | false | false |
| `utilities` | 水道光熱費 | Utilities | false | false |
| `newspapers_books` | 新聞図書費 | Newspapers and books | false | false |
| `membership_dues` | 諸会費 | Membership dues | false | false |
| `payment_fees` | 支払手数料 | Payment and service fees | false | false |
| `rent_lease` | 賃借料 | Rent and lease expenses | false | false |
| `insurance` | 保険料 | Insurance premiums | false | false |

---

## Scope

Use this category list in:

```text
receipt_records
amex_statement_lines
receipt review UI
AMEX line-item categorization UI
monthly AMEX report exports
accountant exports
business trip reports
AI/OCR extraction category suggestions
```

The category code is the value to persist. Japanese and English labels are display/reporting values.

---

## Database Requirements

Add a category master table if one does not already exist:

```sql
CREATE TABLE IF NOT EXISTS expense_categories (
  code TEXT PRIMARY KEY,
  ja_name TEXT NOT NULL,
  en_name TEXT NOT NULL,
  requires_attendees INTEGER NOT NULL DEFAULT 0,
  default_business_trip_eligible INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Add or confirm these category references:

```sql
receipt_records.expense_category_code TEXT
amex_statement_lines.expense_category_code TEXT
```

If the current schema uses `expense_type`, either:

1. migrate to `expense_category_code`, or
2. keep `expense_type` as a backward-compatible alias and map it to `expense_category_code`.

Do not maintain separate divergent category lists in React components.

---

## Migration / Seed Requirements

Create an idempotent migration or seed script that inserts the canonical category list.

Suggested migration name:

```text
db/receipts/0005_expense_categories.sql
```

Use the next available migration number if `0005` is already used.

The migration should use an upsert pattern or `INSERT OR IGNORE` so repeated local/remote application does not duplicate categories.

Example insert shape:

```sql
INSERT OR IGNORE INTO expense_categories (
  code,
  ja_name,
  en_name,
  requires_attendees,
  default_business_trip_eligible,
  display_order,
  is_active,
  created_at,
  updated_at
) VALUES
  ('employee_welfare', '福利厚生費', 'Employee welfare expenses', 0, 0, 10, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('advertising_promotion', '広告宣伝費', 'Advertising and promotion expenses', 0, 0, 20, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('entertainment', '交際費', 'Entertainment expenses', 1, 0, 30, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('meeting', '会議費', 'Meeting expenses', 1, 0, 40, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('travel_transportation', '旅費交通費', 'Travel and transportation expenses', 0, 1, 50, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('communications', '通信費', 'Communications expenses', 0, 0, 60, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('sales_commissions', '販売手数料', 'Sales commissions', 0, 0, 70, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('supplies', '消耗品費', 'Supplies and consumables', 0, 0, 80, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('utilities', '水道光熱費', 'Utilities', 0, 0, 90, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('newspapers_books', '新聞図書費', 'Newspapers and books', 0, 0, 100, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('membership_dues', '諸会費', 'Membership dues', 0, 0, 110, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('payment_fees', '支払手数料', 'Payment and service fees', 0, 0, 120, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rent_lease', '賃借料', 'Rent and lease expenses', 0, 0, 130, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('insurance', '保険料', 'Insurance premiums', 0, 0, 140, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
```

---

## UI Requirements

### Receipt Review Page

On:

```text
/receipts/review/[id]
```

The category selector should show both Japanese and English:

```text
交際費 — Entertainment expenses
会議費 — Meeting expenses
旅費交通費 — Travel and transportation expenses
```

Persist the category `code`, not the display label.

### AMEX Line-Item Page

On:

```text
/receipts/amex
/receipts/reconcile
```

Each AMEX line item must allow category assignment from the master list.

A line item is not report-ready until:

```text
expense_category_code is not null
```

### Display Rules

Default display format:

```text
{ja_name} — {en_name}
```

For exports, include separate columns:

```text
expense_category_code
expense_category_ja
expense_category_en
```

---

## Attendee Requirements

Categories requiring attendees:

| Code | Japanese | English |
|---|---|---|
| `entertainment` | 交際費 | Entertainment expenses |
| `meeting` | 会議費 | Meeting expenses |

If selected category has:

```text
requires_attendees = true
```

then attendee list is required before export.

This applies to both:

- receipt records
- AMEX statement lines

Attendees may come from:

1. linked receipt attendees, or
2. AMEX line attendees if no receipt is linked.

If attendees are missing, the monthly export should block or clearly flag the row as incomplete.

---

## Business Trip Requirements

Business Trip reports are produced for multiple related charges outside Tokyo.

Use:

```text
旅費交通費 / travel_transportation
```

as the primary category for travel/business-trip logic.

Business trip candidate detection should consider:

```text
expense_category_code = travel_transportation
AND outside_tokyo_signal = true
```

But the UI should allow manual assignment of any AMEX line to a business trip.

A single outside-Tokyo charge alone should not automatically create a business trip report. Multiple related outside-Tokyo charges within the configured date window should create a candidate.

Default date window:

```text
7 days
```

Business trip reports should include:

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
expense category Japanese label
expense category English label
```

---

## AI/OCR Extraction Requirements

When AI/OCR extraction suggests an expense category, it must return one of the canonical category codes, not free text.

Allowed values:

```ts
type ExpenseCategoryCode =
  | "employee_welfare"
  | "advertising_promotion"
  | "entertainment"
  | "meeting"
  | "travel_transportation"
  | "communications"
  | "sales_commissions"
  | "supplies"
  | "utilities"
  | "newspapers_books"
  | "membership_dues"
  | "payment_fees"
  | "rent_lease"
  | "insurance";
```

If uncertain:

```text
return null
```

Do not invent category values.

Extraction should show suggestions, not silently overwrite user-entered categories.

Final category assignment is confirmed only when the user saves the reviewed receipt or AMEX line item.

---

## Backward Compatibility Mapping

Map earlier internal categories to the new canonical category codes:

| Old Category | New Code | Notes |
|---|---|---|
| `meeting_no_alcohol` | `meeting` | Attendees required |
| `entertainment_alcohol` | `entertainment` | Attendees required |
| `transportation` | `travel_transportation` | Review if not travel-related |
| `travel` | `travel_transportation` | |
| `business_trip` | `travel_transportation` | Business trip assignment handled separately |
| `books` | `newspapers_books` | |
| `research` | `newspapers_books` | Review if better categorized elsewhere |
| `insurance` | `insurance` | |
| `telecom` | `communications` | |
| `software` | `supplies` | Ambiguous; show as suggestion, require confirmation |
| `office_supplies` | `supplies` | |
| `misc` | null | Require review |
| `unknown` | null | Require review |

Do not silently finalize ambiguous mappings. Show a suggested category and require confirmation.

---

## AMEX Report Requirements

Every AMEX statement line item must have:

```text
expense_category_code
expense_category_ja
expense_category_en
receipt_status
matched_receipt_id or missing receipt reason
attendees if required
business trip assignment if applicable
```

A line is report-ready only when:

```text
expense_category_code is not null
AND receipt status is resolved
AND attendee requirements are satisfied
AND business trip candidate status is resolved
```

### Export Blocking Rules

Block final monthly export if:

```text
any AMEX line has no expense_category_code
any AMEX line has missing receipt without reason
any entertainment or meeting line lacks attendees
any business trip candidate is unresolved
```

---

## Accountant Export Requirements

Monthly accountant exports should include both Japanese and English category labels.

Recommended columns:

```text
statement_month
payment_due_date
transaction_date
cardholder_name
merchant_name
amount_cents
currency
expense_category_code
expense_category_ja
expense_category_en
receipt_status
receipt_id
attendees
business_trip_id
business_trip_name
business_trip_location
business_purpose
notes
```

For attendee-required rows:

```text
交際費 / Entertainment expenses
Attendees: David Klan (Dazbeez), Jane Smith (Client Co.)
```

---

## Coding Agent Tasks

### Task 1: Add Category Master Table

Add `expense_categories` table if one does not already exist.

Seed all 14 categories idempotently.

### Task 2: Add Category References

Add or confirm category references on:

```text
receipt_records
amex_statement_lines
```

Use:

```text
expense_category_code
```

### Task 3: Update Receipt Review UI

Use the category master list for the receipt category selector.

Show:

```text
Japanese label — English label
```

Persist only the code.

### Task 4: Update AMEX Categorization UI

Use the category master list for AMEX line items.

Every AMEX line must be categorizable from this list.

### Task 5: Enforce Attendee Rules

If category requires attendees:

```text
entertainment
meeting
```

then block final export until attendees are provided.

### Task 6: Update AI/OCR Category Mapping

Ensure extraction returns or maps only canonical category codes.

Reject or null unknown values.

### Task 7: Update Business Trip Logic

Use `travel_transportation` as the main business-trip category, combined with outside-Tokyo signals.

### Task 8: Update Reports

Reports must include both Japanese and English category labels.

### Task 9: Add Tests

Add tests for category seed, UI rendering, attendee requirements, AI category validation, AMEX line categorization, and export labels.

---

## Tests

Add or update tests for:

1. Category seed contains all 14 Japanese categories.
2. Each category has an English translation.
3. Category selector renders Japanese and English labels.
4. Receipt review saves `expense_category_code`.
5. AMEX line item saves `expense_category_code`.
6. Meeting category requires attendees before export.
7. Entertainment category requires attendees before export.
8. Travel/transportation category is eligible for business-trip candidate detection.
9. Reports include Japanese and English category labels.
10. AI extraction category must be one of the known category codes.
11. Unknown/free-text categories are rejected or treated as null.
12. Backward compatibility mappings are applied as suggestions, not silently finalized for ambiguous cases.

Run:

```bash
npm test
npm run build:cf
```

---

## Acceptance Criteria

1. All 14 Japanese categories are maintained in the system.
2. Each category has a stable code and English translation.
3. The category list is stored in the system, not duplicated in UI components.
4. Receipt review uses this category list.
5. AMEX line items use this category list.
6. Reports show Japanese and English category labels.
7. Meeting and entertainment categories require attendees before export.
8. Business trip reports use travel/transportation and outside-Tokyo signals.
9. AI/OCR extraction returns only canonical category codes or null.
10. Ambiguous legacy mappings are suggestions that require confirmation.
11. No hard-coded, divergent category lists exist in separate components.
12. `npm test` passes.
13. `npm run build:cf` passes.

---

## Non-Goals

Do not implement in this category update:

- Business trip full workflow if not already scheduled
- Accountant export redesign beyond category columns
- Hard-coded category arrays in multiple places
- Automatic final category assignment without user confirmation
- Free-text categories
- Category deletion without historical-preservation plan

---

## Summary

The system must maintain one canonical category registry:

```text
Japanese category name
English translation
stable category code
attendee requirement
business trip eligibility
```

This registry supports:

```text
receipt review
AMEX line-item tagging
attendee enforcement
business trip reporting
AI/OCR suggestions
monthly accountant exports
```
