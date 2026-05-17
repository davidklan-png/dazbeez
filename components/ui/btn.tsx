import type { ReactNode, ButtonHTMLAttributes } from "react";

type BtnKind = "primary" | "dark" | "danger" | "ghost" | "soft" | "link";
type BtnSize = "sm" | "md" | "lg";

const KIND_CLASSES: Record<BtnKind, string> = {
  primary:
    "bg-amber-500 text-white border-transparent shadow-[0_1px_2px_rgba(217,119,6,0.2)] hover:bg-amber-600",
  dark:
    "bg-gray-900 text-white border-transparent hover:bg-gray-800",
  danger:
    "bg-white text-red-600 border-red-500/30 hover:bg-red-50",
  ghost:
    "bg-white text-gray-700 border-gray-200 hover:bg-gray-50",
  soft:
    "bg-gray-100 text-gray-700 border-transparent hover:bg-gray-200",
  link:
    "bg-transparent text-amber-600 border-transparent hover:text-amber-700 hover:underline",
};

const SIZE_CLASSES: Record<BtnSize, string> = {
  sm: "h-[30px] px-2.5 text-[12.5px] gap-1.5",
  md: "h-9 px-3.5 text-[13px] gap-1.5",
  lg: "h-11 px-5 text-sm gap-2",
};

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  kind?: BtnKind;
  size?: BtnSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  full?: boolean;
}

export function Btn({
  kind = "ghost",
  size = "md",
  leftIcon,
  rightIcon,
  full,
  className = "",
  children,
  disabled,
  ...rest
}: BtnProps) {
  return (
    <button
      type={rest.type ?? "button"}
      disabled={disabled}
      className={[
        "inline-flex items-center justify-center rounded-lg border font-semibold transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        SIZE_CLASSES[size],
        KIND_CLASSES[kind],
        full ? "w-full" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {leftIcon}
      <span>{children}</span>
      {rightIcon}
    </button>
  );
}
