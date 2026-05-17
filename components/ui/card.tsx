import type { ReactNode, HTMLAttributes } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  pad?: number;
}

export function Card({
  children,
  pad = 20,
  className = "",
  style,
  ...rest
}: CardProps) {
  return (
    <div
      className={[
        "rounded-[14px] border border-gray-200 bg-white",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ padding: pad, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}
