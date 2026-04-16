type Props = {
  className?: string;
  opacity?: number;
  color?: string;
};

export function HoneycombBackdrop({
  className = "",
  opacity = 0.12,
  color = "#F59E0B",
}: Props) {
  // One honeycomb tile: two offset rows of pointy-top hexagons.
  // Tile dimensions must tile seamlessly: width = sqrt(3)*r, height = 1.5*r per row.
  const r = 22; // hex circumradius
  const w = Math.round(Math.sqrt(3) * r * 100) / 100; // ~38.1
  const h = 1.5 * r; // 33

  const hex = (cx: number, cy: number) =>
    `M ${cx} ${cy - r} L ${cx + w / 2} ${cy - r / 2} L ${cx + w / 2} ${cy + r / 2} L ${cx} ${cy + r} L ${cx - w / 2} ${cy + r / 2} L ${cx - w / 2} ${cy - r / 2} Z`;

  const tileW = w;
  const tileH = h * 2;

  const paths = [
    hex(w / 2, r),
    hex(0, r + h),
    hex(w, r + h),
  ].join(" ");

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 ${className}`}
      style={{ opacity }}
    >
      <svg className="h-full w-full" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern
            id="honeycomb-pattern"
            x="0"
            y="0"
            width={tileW}
            height={tileH}
            patternUnits="userSpaceOnUse"
          >
            <path d={paths} fill="none" stroke={color} strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#honeycomb-pattern)" />
      </svg>
    </div>
  );
}
