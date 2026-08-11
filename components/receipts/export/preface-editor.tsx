"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Btn } from "@/components/ui/btn";
import { buildPackNotice, type PackNoticeInput } from "@/lib/receipts/proofs";
import type { PackNames } from "@/lib/receipts/pack-naming";

/**
 * Editable preface (【今月のご連絡】) editor for the export review screen (E2).
 * The ONLY UI that writes operator_message — it PATCHes
 * /api/receipts/export/[month]/message (E1), which stores on the open draft
 * revision only and 409s when the month is sealed.
 *
 * - Explicit Save button (autosave is out of scope): the message is frozen into
 *   the sealed bytes at pack-build, so an unsaved edit must never silently ship.
 * - Saved / unsaved indicator + character count against the 2000-char server cap.
 * - Live preview: the first ~10 lines of the REAL buildPackNotice output (never
 *   a reimplementation of the layout), with the unsaved draft spliced in so the
 *   operator sees the preface sitting above 【この資料について】.
 * - Disabled with an explanation when there is no open draft (sealed), matching
 *   the 409 condition the PATCH endpoint enforces server-side.
 */
export function PrefaceEditor({
  month,
  initialMessage,
  editable,
  noticeInput,
  names,
  onDirtyChange,
}: {
  month: string;
  initialMessage: string | null;
  editable: boolean;
  /** Server-derived notice input (counts, missing-receipt lines, hasAmex/…).
   *  The operatorMessage field is overridden client-side with the live draft. */
  noticeInput: PackNoticeInput;
  /** Pack names from the single naming authority. null only when the AMEX
   *  payment-due date is unavailable (an AMEX month whose statement artifact
   *  predates the 0035 snapshot) — the preview is hidden in that case. */
  names: PackNames | null;
  /** Lifted dirty signal so the Finalize button can disable (and name the
   *  reason) while the preface has unsaved edits — the client-side half of the
   *  2026-06 message-loss fix (the server half is the message_not_reviewed gate). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(initialMessage ?? "");
  const [saved, setSaved] = useState(initialMessage ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const router = useRouter();

  const dirty = draft !== saved;
  const overCap = draft.length > 2000;

  // Lift the dirty flag so the finalize gate (a sibling client component) can
  // block sealing while there are unsaved preface edits.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Live preview via the real builder — operatorMessage is the live draft, every
  // other input is the server-derived month state. Sliced to ~10 lines so the
  // operator sees the preface + the 【この資料について】 heading it sits above.
  const preview = useMemo(() => {
    if (!names) return null;
    const full = buildPackNotice(
      { ...noticeInput, operatorMessage: draft },
      names,
    );
    return full.split(/\r?\n/).slice(0, 10).join("\n");
  }, [names, noticeInput, draft]);

  /** Persist the preface. `message` is the exact value to store (trimmed server-
   *  side); pass "" to record an explicit "no message this month" decision — the
   *  server stores NULL + sets the decision timestamp, clearing the
   *  message_not_reviewed finalize blocker. */
  async function persist(message: string) {
    if (!editable || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/receipts/export/${month}/message`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        operatorMessage?: string | null;
        error?: string;
      };
      if (!res.ok) {
        setError(json.error ?? "保存に失敗しました。");
        return false;
      }
      // Normalize to the server-stored (trimmed / NULL-cleared) value so the
      // dirty flag settles even when the server trims whitespace.
      const stored = json.operatorMessage ?? "";
      setSaved(stored);
      setDraft(stored);
      setSavedAt(
        new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
      );
      // §2 (Codex P2 on #169): a verified save (res.ok ⇒ the rows-affected-checked
      // write persisted) moves the server gate from message_not_reviewed to
      // message_stale. The gate panel + FinalizeCard.blockerCount are server-
      // rendered, so refresh them — never on an unverified/failed save. Refresh
      // preserves this component's client state (draft/saved/savedAt are not
      // reset by router.refresh), so the saved indicator is not bounced and
      // unsaved edits are not clobbered.
      router.refresh();
      return true;
    } catch {
      setError("通信エラーが発生しました。");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const save = () => persist(draft);
  /** "No message this month" — a deliberate decision that writes the timestamp
   *  with a NULL message, clearing message_not_reviewed without typing text. */
  const decideNoMessage = () => persist("");

  // A successful "no message" save leaves saved === "" with a timestamp; surface
  // it distinctly so it doesn't read as "forgot to type."
  const decidedNoMessage = !dirty && saved === "" && savedAt !== null;

  return (
    <div className="mx-8 mb-4 rounded-xl border border-gray-200 bg-white px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor="preface" className="text-[13px] font-semibold text-gray-900">
          今月のご連絡（任意）
        </label>
        <span
          className={[
            "text-[11px]",
            overCap ? "font-semibold text-red-600" : "text-gray-400",
          ].join(" ")}
        >
          {draft.length} / 2000
        </span>
      </div>
      <p className="mt-1 text-[11.5px] text-gray-500">
        パックのご連絡事項.txt と送信メールの両方に、同じ文面が入ります。件数や集計は変わりません。
      </p>

      {editable ? (
        <>
          <textarea
            id="preface"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            placeholder="例：今月は出張費用が多めです（6/10–6/12 大阪）。詳細は領収書をご確認ください。"
            className="mt-2.5 w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-[13px] leading-relaxed text-gray-900 outline-none focus:border-amber-500"
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <Btn
              kind="primary"
              size="md"
              onClick={save}
              disabled={!dirty || saving || overCap}
            >
              {saving ? "保存中…" : "保存"}
            </Btn>
            <Btn
              kind="soft"
              size="md"
              onClick={decideNoMessage}
              disabled={saving || decidedNoMessage}
              title="今月はメッセージなしと明示的に記録します（タイムスタンプを書き込みます）"
            >
              今月はメッセージなし
            </Btn>
            <span className="text-[11.5px] text-gray-500">
              {dirty ? (
                <span className="text-amber-700">未保存</span>
              ) : decidedNoMessage ? (
                <span>メッセージなし（保存済み {savedAt}）</span>
              ) : savedAt ? (
                <span>保存済み（{savedAt}）</span>
              ) : initialMessage ? (
                <span>保存済み</span>
              ) : (
                <span>未入力</span>
              )}
            </span>
            {error && (
              <span className="text-[11.5px] text-red-600">{error}</span>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="mt-2.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[13px] leading-relaxed text-gray-700">
            {initialMessage ? (
              <span className="whitespace-pre-wrap">{initialMessage}</span>
            ) : (
              <span className="text-gray-400">（未入力）</span>
            )}
          </div>
          <p className="mt-2 text-[11.5px] text-gray-500">
            {month} は封印済みです。メッセージを変更するには改訂を作成してください。
          </p>
        </>
      )}

      {preview && (
        <div className="mt-4">
          <div className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.05em] text-gray-500">
            プレビュー — ご連絡事項.txt の先頭
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-gray-150 bg-gray-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-700">
            {preview}
          </pre>
        </div>
      )}
    </div>
  );
}
