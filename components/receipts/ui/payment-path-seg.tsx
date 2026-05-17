"use client";

import type { PaymentPath } from "@/lib/receipts/types";

const ITEMS: PaymentPath[] = ["AMEX", "CASH", "DIGITAL", "UNKNOWN"];

export function PaymentPathSeg({
  value,
  onChange,
  disabled,
}: {
  value: PaymentPath;
  onChange?: (next: PaymentPath) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Payment path"
      className="inline-flex gap-[2px] rounded-[9px] bg-gray-100 p-[3px]"
    >
      {ITEMS.map((it) => {
        const on = it === value;
        return (
          <button
            key={it}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => !disabled && onChange?.(it)}
            className={[
              "rounded-[7px] px-3.5 py-1.5 text-[12.5px] transition-colors",
              on
                ? "bg-white font-semibold text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                : "font-medium text-gray-500 hover:text-gray-700",
              disabled ? "cursor-not-allowed opacity-50" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {it}
          </button>
        );
      })}
    </div>
  );
}
