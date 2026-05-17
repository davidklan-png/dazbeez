"use client";

import type { ReactNode, InputHTMLAttributes } from "react";

export function Field({
  label,
  hint,
  required,
  status,
  children,
  className = "",
}: {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  status?: "saved" | "saving" | "error";
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={["block", className].filter(Boolean).join(" ")}>
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.04em] text-gray-500">
        <span>{label}</span>
        {required && <span className="text-amber-600">•</span>}
        {status === "saved" && (
          <span className="text-[11px] font-medium normal-case tracking-normal text-green-700">
            ✓ saved
          </span>
        )}
        {status === "saving" && (
          <span className="text-[11px] font-medium normal-case tracking-normal text-amber-600">
            saving…
          </span>
        )}
        {status === "error" && (
          <span className="text-[11px] font-medium normal-case tracking-normal text-red-600">
            failed
          </span>
        )}
        {hint && (
          <span className="ml-auto text-[11px] normal-case tracking-normal text-gray-400">
            {hint}
          </span>
        )}
      </div>
      {children}
    </label>
  );
}

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  mono?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
  containerClassName?: string;
}

export function TextInput({
  mono,
  prefix,
  suffix,
  className = "",
  containerClassName = "",
  readOnly,
  ...rest
}: TextInputProps) {
  return (
    <div
      className={[
        "flex h-[38px] items-center gap-2 rounded-lg border border-gray-200 px-3",
        readOnly ? "bg-gray-50" : "bg-white",
        "focus-within:border-amber-500",
        containerClassName,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {prefix && <span className="text-[13px] text-gray-400">{prefix}</span>}
      <input
        readOnly={readOnly}
        className={[
          "min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none tabular-nums placeholder:text-gray-400",
          mono ? "font-mono" : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      />
      {suffix && <span className="text-[12px] text-gray-500">{suffix}</span>}
    </div>
  );
}

export interface DisplayInputProps {
  value?: string;
  placeholder?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  mono?: boolean;
  readOnly?: boolean;
  className?: string;
}

export function DisplayInput({
  value,
  placeholder,
  prefix,
  suffix,
  mono,
  readOnly,
  className = "",
}: DisplayInputProps) {
  return (
    <div
      className={[
        "flex h-[38px] items-center gap-2 rounded-lg border border-gray-200 px-3",
        readOnly ? "bg-gray-50" : "bg-white",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {prefix && <span className="text-[13px] text-gray-400">{prefix}</span>}
      <span
        className={[
          "min-w-0 flex-1 truncate text-sm tabular-nums",
          value ? "text-gray-900" : "text-gray-400",
          mono ? "font-mono" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value || placeholder}
      </span>
      {suffix && <span className="text-[12px] text-gray-500">{suffix}</span>}
    </div>
  );
}

export interface SelectInputProps
  extends Omit<InputHTMLAttributes<HTMLSelectElement>, "size"> {
  containerClassName?: string;
  options: Array<{ value: string; label: string }>;
}

export function SelectInput({
  containerClassName = "",
  options,
  className = "",
  ...rest
}: SelectInputProps) {
  return (
    <div
      className={[
        "relative flex h-[38px] items-center rounded-lg border border-gray-200 bg-white",
        "focus-within:border-amber-500",
        containerClassName,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <select
        className={[
          "h-full w-full appearance-none rounded-lg bg-transparent pl-3 pr-8 text-sm text-gray-900 outline-none",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-gray-400"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
  );
}
