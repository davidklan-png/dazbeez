export function ReceiptThumb({
  size = 56,
  merchant = "RECEIPT",
  amount = "—",
  tone = "paper",
}: {
  size?: number;
  merchant?: string;
  amount?: string;
  tone?: "paper" | "gray";
}) {
  const height = Math.round(size * 1.25);
  return (
    <div
      className={[
        "flex shrink-0 flex-col gap-[2px] overflow-hidden rounded-[4px] border border-gray-200 p-1 shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
        tone === "paper" ? "bg-[#fcf9f2]" : "bg-gray-100",
      ].join(" ")}
      style={{ width: size, height }}
      aria-hidden
    >
      <div className="text-[6px] font-bold leading-[1.2] text-gray-900">
        {merchant.toUpperCase().slice(0, 12)}
      </div>
      <div className="h-px bg-gray-200" />
      <div className="h-[2px] w-[70%] bg-gray-150" />
      <div className="h-[2px] w-[85%] bg-gray-150" />
      <div className="h-[2px] w-[60%] bg-gray-150" />
      <div className="flex-1" />
      <div className="text-right text-[7px] font-bold tabular-nums text-gray-900">
        {amount}
      </div>
    </div>
  );
}
