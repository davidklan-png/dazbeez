import type { ReactNode } from "react";

export function FormGroup({
  step,
  title,
  subtitle,
  done,
  active,
  optional,
  children,
}: {
  step: number | string;
  title: ReactNode;
  subtitle?: ReactNode;
  done?: boolean;
  active?: boolean;
  optional?: boolean;
  children: ReactNode;
}) {
  const dotBg = done
    ? "bg-green-500 text-white"
    : active
      ? "bg-amber-500 text-white"
      : "bg-gray-300 text-gray-500";

  return (
    <section className="mt-[18px]">
      <header className="mb-2.5 flex items-center gap-2.5">
        <div
          className={`flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold ${dotBg}`}
        >
          {done ? "✓" : step}
        </div>
        <span className="text-sm font-semibold text-gray-900">{title}</span>
        {optional && <span className="text-[11px] text-gray-400">optional</span>}
        <span className="flex-1" />
        {subtitle && (
          <span className="text-[11.5px] text-gray-500">{subtitle}</span>
        )}
      </header>
      {children}
    </section>
  );
}
