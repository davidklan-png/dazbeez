import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const reviewForm = readFileSync(
  "components/receipts/review/form-pane.tsx",
  "utf8",
);
const reconcileScreen = readFileSync(
  "components/receipts/reconcile/reconcile-screen.tsx",
  "utf8",
);

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test("review autosave never refreshes the route while an operator is typing", () => {
  // WebKit Japanese IME composition is interrupted by a route refresh. This
  // protects EVERY editable review field, rather than a single field-specific
  // composition handler that can regress normal input.
  const autosave = section(
    reviewForm,
    "const triggerSave = useCallback(",
    "// ADR 0006 §D6",
  );
  assert.doesNotMatch(autosave, /router\.refresh\(/);
});

test("Business purpose is DOM-owned and its composition guard is ref-only", () => {
  // Both state at compositionstart and a controlled value during later renders
  // have broken Sonoma WebKit IME. The DOM owns marked text until commit.
  assert.match(
    reviewForm,
    /const businessPurposeComposingRef = useRef\(false\)/,
  );
  assert.doesNotMatch(reviewForm, /isBusinessPurposeComposing/);
  assert.doesNotMatch(reviewForm, /setBusinessPurpose/);
  const compositionStart = section(
    reviewForm,
    "const handleBusinessPurposeCompositionStart",
    "const handleBusinessPurposeCompositionEnd",
  );
  assert.doesNotMatch(compositionStart, /\bset[A-Z]\w*\(/);
  assert.match(compositionStart, /businessPurposeComposingRef\.current = true/);
  const documentationField = section(
    reviewForm,
    'label="Business purpose"',
    'label="Attendees"',
  );
  assert.match(documentationField, /onCompositionStart=/);
  assert.match(documentationField, /onCompositionEnd=/);
  assert.match(documentationField, /defaultValue=/);
  assert.doesNotMatch(documentationField, /\svalue=\{/);
});

test("IME Enter does not blur the Missing receipt reason field", () => {
  // Enter confirms a Japanese candidate. Blurring from its keydown handler
  // drops focus before the operator has finished typing; persistence remains
  // on a normal blur instead.
  const noReceiptFields = section(
    reconcileScreen,
    "function NoReceiptFields(",
    "function FinalizeModal(",
  );
  assert.doesNotMatch(noReceiptFields, /currentTarget\.blur\(/);
  assert.match(noReceiptFields, /onBlur=\{saveMissingReason\}/);
});
