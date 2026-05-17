import type { ReactNode } from "react";

export type PillTone =
  | "gray"
  | "amber"
  | "green"
  | "red"
  | "blue"
  | "purple"
  | "outline";

export type PillSize = "sm" | "md";

const TONES: Record<PillTone, { bg: string; fg: string; dot: string; border?: string }> = {
  gray:    { bg: "bg-gray-100",   fg: "text-gray-700",   dot: "bg-gray-400" },
  amber:   { bg: "bg-amber-50",   fg: "text-amber-700",  dot: "bg-amber-500" },
  green:   { bg: "bg-green-100",  fg: "text-green-700",  dot: "bg-green-500" },
  red:     { bg: "bg-red-100",    fg: "text-red-600",    dot: "bg-red-500" },
  blue:    { bg: "bg-blue-100",   fg: "text-blue-700",   dot: "bg-blue-500" },
  purple:  { bg: "bg-purple-100", fg: "text-purple-700", dot: "bg-violet-500" },
  outline: { bg: "bg-white",      fg: "text-gray-600",   dot: "bg-gray-300", border: "border border-gray-200" },
};

const SIZES: Record<PillSize, string> = {
  sm: "px-[7px] py-[2px] text-[11px] gap-[5px]",
  md: "px-[9px] py-[3px] text-[11.5px] gap-1.5",
};

export function Pill({
  children,
  tone = "gray",
  size = "md",
  dot,
  className = "",
}: {
  children: ReactNode;
  tone?: PillTone;
  size?: PillSize;
  dot?: boolean;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span
      className={[
        "inline-flex items-center rounded-full font-medium leading-[1.4] whitespace-nowrap",
        SIZES[size],
        t.bg,
        t.fg,
        t.border ?? "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />}
      {children}
    </span>
  );
}
