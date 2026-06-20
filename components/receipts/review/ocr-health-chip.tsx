import type { ExtractionHealth } from "@/lib/receipts/extraction-state";

/**
 * One-glance OCR-processor status for the Review header.
 *
 * OCR runs on the Mac MLX consumer (ADR 0001); this chip answers the only
 * question that matters operationally: is that processor draining the queue
 * (green) or has it stalled (amber). When stalled the title spells out the fix.
 */
export function OcrHealthChip({ health }: { health: ExtractionHealth }) {
  const ok = health.ok;
  const dotClass = ok ? "bg-emerald-500" : "bg-amber-500";
  const textClass = ok ? "text-gray-500" : "text-amber-700";
  const borderClass = ok ? "border-gray-200" : "border-amber-300 bg-amber-50";

  const title = ok
    ? health.lastProcessedAt
      ? `OCR processor OK — last processed ${health.lastProcessedAt}`
      : "OCR processor OK"
    : "OCR processor not draining the queue. On the Mac: run scripts/receipts-consumer/run.sh --once, or load the launchd agent so it drains automatically.";

  return (
    <span
      title={title}
      className={[
        "inline-flex items-center gap-1.5 rounded-[7px] border px-2 py-0.5 text-[11.5px] font-medium",
        borderClass,
        textClass,
      ].join(" ")}
    >
      <span className={["h-1.5 w-1.5 rounded-full", dotClass].join(" ")} />
      <span>OCR processor</span>
      <span className="text-gray-400">·</span>
      <span>{ok ? "OK" : "stalled"}</span>
    </span>
  );
}
