import type { ReactNode } from "react";

export type ServiceVariant = "ai" | "automation" | "data" | "governance" | "pm";
export type HexIconSize = "sm" | "md" | "lg";

const accents: Record<ServiceVariant, { fill: string; stroke: string; icon: string; ring: string }> = {
  ai:         { fill: "#FEF3C7", stroke: "#F59E0B", icon: "#B45309", ring: "rgba(245,158,11,0.35)" },
  automation: { fill: "#FFEDD5", stroke: "#F97316", icon: "#9A3412", ring: "rgba(249,115,22,0.35)" },
  data:       { fill: "#FEF9C3", stroke: "#CA8A04", icon: "#854D0E", ring: "rgba(202,138,4,0.35)"  },
  governance: { fill: "#F5F5F4", stroke: "#57534E", icon: "#292524", ring: "rgba(87,83,78,0.35)"   },
  pm:         { fill: "#FEF3C7", stroke: "#B45309", icon: "#78350F", ring: "rgba(180,83,9,0.35)"   },
};

const sizes: Record<HexIconSize, { box: number; stroke: number }> = {
  sm: { box: 40, stroke: 2 },
  md: { box: 72, stroke: 2.25 },
  lg: { box: 112, stroke: 2.5 },
};

function Glyph({ variant, color }: { variant: ServiceVariant; color: string }) {
  switch (variant) {
    case "ai":
      return (
        <g stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none">
          <circle cx="0" cy="0" r="3.2" fill={color} fillOpacity={0.15} />
          <circle cx="-8" cy="-5.5" r="1.6" />
          <circle cx="8" cy="-5.5" r="1.6" />
          <circle cx="-8" cy="5.5" r="1.6" />
          <circle cx="8" cy="5.5" r="1.6" />
          <line x1="-6.7" y1="-4.9" x2="-1.9" y2="-1.4" />
          <line x1="6.7" y1="-4.9" x2="1.9" y2="-1.4" />
          <line x1="-6.7" y1="4.9" x2="-1.9" y2="1.4" />
          <line x1="6.7" y1="4.9" x2="1.9" y2="1.4" />
        </g>
      );
    case "automation":
      return (
        <g stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none">
          <circle cx="0" cy="0" r="3" />
          <path d="M0 -10 L0 -6 M0 10 L0 6 M-10 0 L-6 0 M10 0 L6 0 M-7 -7 L-4.2 -4.2 M7 -7 L4.2 -4.2 M-7 7 L-4.2 4.2 M7 7 L4.2 4.2" />
        </g>
      );
    case "data":
      return (
        <g stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none">
          <ellipse cx="0" cy="-6" rx="8" ry="2.5" />
          <path d="M-8 -6 L-8 6 A8 2.5 0 0 0 8 6 L8 -6" />
          <path d="M-8 0 A8 2.5 0 0 0 8 0" />
        </g>
      );
    case "governance":
      return (
        <g stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M0 -10 L8 -6 L8 2 C8 7 4 10 0 11 C-4 10 -8 7 -8 2 L-8 -6 Z" />
          <path d="M-3.2 0.5 L-0.6 3.2 L4 -2" />
        </g>
      );
    case "pm":
      return (
        <g stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none">
          <rect x="-8.5" y="-8" width="17" height="16" rx="2" />
          <path d="M-8.5 -3 L8.5 -3" />
          <path d="M-5 -6 L-5 -8 M5 -6 L5 -8" />
          <path d="M-5 1 L-2 4 L5 -3" />
        </g>
      );
  }
}

export function HexIcon({
  variant,
  size = "md",
  label,
  children,
}: {
  variant: ServiceVariant;
  size?: HexIconSize;
  label?: string;
  children?: ReactNode;
}) {
  const { fill, stroke, icon, ring } = accents[variant];
  const { box, stroke: strokeWidth } = sizes[size];
  // Pointy-top hexagon, circumradius 30 on a -32..32 viewbox
  const points = "0,-30 26,-15 26,15 0,30 -26,15 -26,-15";

  const role = label ? "img" : "presentation";
  const ariaLabel = label;

  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: box, height: box, filter: `drop-shadow(0 6px 14px ${ring})` }}
      aria-hidden={label ? undefined : true}
    >
      <svg
        viewBox="-32 -32 64 64"
        width={box}
        height={box}
        role={role}
        aria-label={ariaLabel}
      >
        <polygon points={points} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
        {children ?? <Glyph variant={variant} color={icon} />}
      </svg>
    </span>
  );
}

export function hexAccent(variant: ServiceVariant) {
  return accents[variant];
}
