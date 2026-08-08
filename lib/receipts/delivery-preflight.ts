// Pre-send preflight on the actual sealed pack bytes (Phase B Change 3; O6).
//
// A gate that checks a different object than the one being sent is not a gate.
// This runs pack-preflight against the SAME proofs-ZIP bytes the caller will
// deliver — fetched once from R2 (B-5: no live D1 re-derivation, no second read
// that could differ if the object were replaced). The caller passes the in-
// memory zipBytes; nothing here re-fetches.

import { unzipSync } from "fflate";
import {
  runPackPreflight,
  sumReconChargeAmounts,
  type PackPreflightEntry,
  type PackPreflightInput,
  type PackPreflightReport,
  type PreflightCsvInput,
} from "@/lib/receipts/pack-preflight";
import { buildPackNames } from "@/lib/receipts/pack-naming";

/** Decode ZIP-entry bytes as UTF-8 and strip a leading BOM. The pack CSVs are
 *  UTF-8-BOM by design; PreflightCsvInput documents text as "BOM stripped by the
 *  caller". An unstripped BOM makes the first header cell "﻿利用日" and
 *  breaks every column lookup — failing in a way that looks like a naming bug
 *  rather than an encoding one. */
function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Run the pre-send preflight against the actual sealed proofs-ZIP bytes.
 *
 * The unzipped entry buffers are local to this call; only the report is
 * returned, so they can be collected before the caller base64-encodes the ZIP
 * for the send — keeping peak memory down (the fetched ZIP + base64 are the
 * long-lived buffers; the unzipped entries are transient).
 */
export async function runPreflightOnSealedZip(opts: {
  zipBytes: Uint8Array;
  month: string;
  /** The sealed export's snapshotted payment-due date (0035) — never a live
   *  lookup of the current statement artifact. */
  paymentDueDate: string | null;
  maxPackBytes: number;
}): Promise<PackPreflightReport> {
  const names = buildPackNames(opts.month, opts.paymentDueDate, opts.paymentDueDate != null);
  const files = unzipSync(opts.zipBytes);
  const root = names.rootFolder;
  const byName = new Map<string, Uint8Array>(Object.entries(files));
  const entries: PackPreflightEntry[] = Object.entries(files).map(([name, bytes]) => ({
    name,
    bytes,
  }));

  const rootText = (packName: string): string | null => {
    const b = byName.get(`${root}/${packName}`);
    return b ? decodeText(b) : null;
  };

  const csvs: PreflightCsvInput[] = [];
  const pushCsv = (label: string, packName: string) => {
    const text = rootText(packName);
    if (text !== null) csvs.push({ label, text });
  };
  pushCsv("集計", names.summaryCsv);
  pushCsv("AMEX", names.amexReconciliationCsv);
  pushCsv("CASH", names.cashReconciliationCsv);
  pushCsv("DIGITAL", names.digitalReconciliationCsv);

  const noticeText = rootText(names.noticeFile) ?? "";
  // AMEX statement total from the sealed AMEX 照合CSV — the INDEPENDENT source
  // for summary-payment-path-reconciles (reading it from 集計 would be circular).
  const amexText = rootText(names.amexReconciliationCsv);
  const amexStatementTotalCents = amexText !== null ? sumReconChargeAmounts(amexText) : null;

  const input: PackPreflightInput = {
    month: opts.month,
    paymentDueDate: opts.paymentDueDate,
    containerNames: { zipName: names.zipName, rootFolder: names.rootFolder },
    entries,
    noticeText,
    csvs,
    amexStatementTotalCents,
    maxPackBytes: opts.maxPackBytes,
  };
  return runPackPreflight(input);
}
