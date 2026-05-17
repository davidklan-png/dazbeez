import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex min-w-[18px] items-center justify-center rounded-[5px] border border-gray-200 border-b-[1.5px] border-b-gray-300 bg-white px-1.5 py-[1px] font-mono text-[11px] leading-[1.4] text-gray-700">
      {children}
    </span>
  );
}
