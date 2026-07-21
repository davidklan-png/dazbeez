import type { PreservationField } from "@/lib/receipts/duplicate-resolution-policy";

export type ResolutionAction = "copy_from_source" | "keep_retained" | "manual_value";

export interface ManualAmountValue {
  amountMinor: number;
  currency: string;
}

export interface ManualAttendeeValue {
  attendeeName: string;
  company?: string | null;
  relationship?: string | null;
  isDazbeezEmployee?: boolean;
  notes?: string | null;
}

export interface ManualAttendeesValue {
  attendees: ManualAttendeeValue[];
}

export interface FieldResolution {
  field: PreservationField;
  action: ResolutionAction;
  /** Scalar copies use exactly one source; attendee copies may union several. */
  sourceReceiptIds?: string[];
  manualValue?: unknown;
}

export interface DuplicateMergeApiResult {
  applied: true;
  updatedFields: PreservationField[];
  attendeeAdditions: ManualAttendeeValue[];
  resolvedFields: PreservationField[];
  warnings: string[];
  correction: {
    exportId: string;
    month: string;
    revision: number;
    reason: string;
  } | null;
  auditId: string;
}
