export function BeeMark({ size = 22 }: { size?: number }) {
  const inner = size * 0.55;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full text-white font-bold shadow-[0_1px_2px_rgba(217,119,6,0.25)]"
      style={{
        width: size,
        height: size,
        background: "linear-gradient(135deg, #FBBF24, #D97706)",
      }}
      aria-hidden
    >
      <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none">
        <ellipse cx="12" cy="13" rx="6.5" ry="5" fill="#fff" />
        <rect x="6" y="11" width="12" height="1.4" fill="#B45309" />
        <rect x="6" y="14" width="12" height="1.4" fill="#B45309" />
        <ellipse cx="8.5" cy="9" rx="3" ry="2" fill="#fff" opacity="0.9" />
        <ellipse cx="15.5" cy="9" rx="3" ry="2" fill="#fff" opacity="0.9" />
      </svg>
    </span>
  );
}
