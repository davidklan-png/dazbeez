"use client";

import { useState } from "react";
import { PrefaceEditor } from "@/components/receipts/export/preface-editor";
import { FinalizeCard } from "@/components/receipts/export/finalize-card";
import type { ReceiptExport } from "@/lib/receipts/types";
import type { PackNoticeInput } from "@/lib/receipts/proofs";
import type { PackNames } from "@/lib/receipts/pack-naming";

/**
 * Pairs the PrefaceEditor and the FinalizeCard behind ONE piece of client state:
 * whether the preface has unsaved edits. ReviewScreen is a server component and
 * cannot hold that state, and the two are otherwise independent client islands.
 *
 * The dirty flag is the client-side half of the 2026-06 message-loss fix. The
 * server half is the `message_not_reviewed` finalize gate, which catches a field
 * the operator never opened; this catches the narrower case the gate cannot see
 * — an edit made AFTER a prior save (the server only knows the last persisted
 * value). When dirty, FinalizeCard disables and names the reason in its button.
 */
export function PrefaceFinalizeSection({
  month,
  monthLabel,
  currentExport,
  finalized,
  blockerCount,
  warningCount,
  rowsInDraft,
  hasProofsZip,
  noticeInput,
  names,
}: {
  month: string;
  monthLabel: string;
  currentExport: ReceiptExport | null;
  finalized: boolean;
  blockerCount: number;
  warningCount: number;
  rowsInDraft: number;
  hasProofsZip: boolean;
  noticeInput: PackNoticeInput;
  names: PackNames | null;
}) {
  const [prefaceDirty, setPrefaceDirty] = useState(false);

  return (
    <>
      {currentExport && (
        <PrefaceEditor
          month={month}
          initialMessage={currentExport.operator_message ?? null}
          editable={currentExport.status === "draft"}
          noticeInput={noticeInput}
          names={names}
          onDirtyChange={setPrefaceDirty}
        />
      )}

      <FinalizeCard
        month={month}
        monthLabel={monthLabel}
        finalized={finalized}
        operatorMessage={currentExport?.operator_message ?? null}
        blockerCount={blockerCount}
        warningCount={warningCount}
        rowsInDraft={rowsInDraft}
        hasProofsZip={hasProofsZip}
        prefaceDirty={prefaceDirty}
      />
    </>
  );
}
