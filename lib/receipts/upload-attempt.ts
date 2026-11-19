import { maybeResizeImage } from "./client-image";
import { SingleFlight } from "./single-flight";
import type { PaymentPath } from "./types";
import type { Source } from "./upload-policy";

export type CapturePhase =
  | { kind: "idle" }
  | { kind: "uploading"; pct: number; fileName: string; fileSizeBytes: number }
  | { kind: "saved"; receiptId: string; reviewUrl: string; capturedAt: number }
  | { kind: "error"; message: string; fileName?: string };

export type UploadResult =
  | { ok: true; receiptId: string; reviewUrl: string }
  | { ok: false; message: string };

/** One selection: retries keep the normalized bytes and metadata, even after abort. */
export class UploadAttempt {
  private prepared: Promise<FormData> | null = null;
  private gate = new SingleFlight();
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(
    private file: File | null,
    private readonly paymentPath: PaymentPath | null,
    private readonly source: Source,
    private readonly captureId: string,
  ) {}

  private prepare(): Promise<FormData> {
    if (!this.prepared) {
      this.prepared = maybeResizeImage(this.file!).then((file) => {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("source", this.source);
        fd.append("client_capture_id", this.captureId);
        if (this.paymentPath) fd.append("paymentPath", this.paymentPath);
        return fd;
      }).catch((error) => {
        this.prepared = null;
        throw error;
      });
    }
    return this.prepared;
  }

  cancel() {
    this.controller?.abort();
    this.controller = null;
    this.gate.finish();
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.file = null;
    this.prepared = null;
  }

  async run(publish: (phase: CapturePhase) => void): Promise<UploadResult> {
    if (this.disposed || !this.file || !this.gate.start()) {
      return { ok: false, message: "Upload unavailable or already running." };
    }
    const abort = new AbortController();
    this.controller = abort;
    const current = () => !this.disposed && !abort.signal.aborted;
    const fileName = this.file.name;
    publish({ kind: "uploading", pct: 5, fileName, fileSizeBytes: this.file.size });
    try {
      const fd = await this.prepare();
      if (!current()) return { ok: false, message: "Cancelled" };
      const file = fd.get("file") as File;
      publish({ kind: "uploading", pct: 30, fileName: file.name, fileSizeBytes: file.size });
      const res = await fetch("/api/receipts/upload", { method: "POST", body: fd, signal: abort.signal });
      if (!current()) return { ok: false, message: "Cancelled" };
      // Auth redirects can return HTML; classify the status before parsing JSON.
      if (res.status === 401 || res.status === 403 || res.redirected) {
        throw new Error("Sign in in another tab, then Retry here to keep this photo.");
      }
      const json = await res.json().catch(() => ({})) as { receiptId?: string; reviewUrl?: string; error?: string };
      if (!current()) return { ok: false, message: "Cancelled" };
      if (!res.ok || typeof json.receiptId !== "string" || !json.receiptId) {
        const detail = typeof json.error === "string" ? json.error : "Upload was not confirmed.";
        throw new Error(res.status >= 400 && res.status < 500
          ? `${detail} Retry keeps the same photo and details; discard/retake to replace them. Check recent captures first.`
          : `${detail} Retry this photo to confirm the outcome.`);
      }
      const reviewUrl = typeof json.reviewUrl === "string" ? json.reviewUrl : `/receipts/review/${json.receiptId}`;
      publish({ kind: "saved", receiptId: json.receiptId, reviewUrl, capturedAt: Date.now() });
      this.dispose();
      return { ok: true, receiptId: json.receiptId, reviewUrl };
    } catch (error) {
      if (!current()) return { ok: false, message: "Cancelled" };
      const message = error instanceof Error ? error.message : "Network error — Retry this photo.";
      publish({ kind: "error", message, fileName });
      return { ok: false, message };
    } finally {
      // An aborted run may finish after its retry has already started.
      if (this.controller === abort) {
        this.controller = null;
        this.gate.finish();
      }
    }
  }
}
