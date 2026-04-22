import { ImageResponse } from "next/og";
import type { ServiceSlug } from "@/lib/services";

const brand = {
  amber: "#F59E0B",
  amberLight: "#FBBF24",
  charcoal: "#111827",
  charcoalSoft: "#1F2937",
  white: "#F9FAFB",
  muted: "#D1D5DB",
  slate: "#9CA3AF",
};

export const ogImageSize = {
  width: 1200,
  height: 630,
};

export const twitterImageSize = {
  width: 800,
  height: 418,
};

export const imageContentType = "image/png";

type SocialVisualKind =
  | "services"
  | "about"
  | "contact"
  | "nfc"
  | "privacy"
  | "terms"
  | "twitter"
  | ServiceSlug;

type SocialImageOptions = {
  accent?: string;
  eyebrow: string;
  footer?: string;
  pills?: string[];
  size: { width: number; height: number };
  subtitle: string;
  title: string;
  visual: SocialVisualKind;
};

function BrandLockup({ compact }: { compact: boolean }) {
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        gap: compact ? "16px" : "20px",
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "linear-gradient(135deg, #fbbf24, #f59e0b)",
          borderRadius: "9999px",
          color: brand.charcoal,
          display: "flex",
          fontFamily: "Inter, sans-serif",
          fontSize: compact ? "28px" : "34px",
          fontWeight: 800,
          height: compact ? "68px" : "84px",
          justifyContent: "center",
          width: compact ? "68px" : "84px",
        }}
      >
        D
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: compact ? "8px" : "10px",
        }}
      >
        <div
          style={{
            color: brand.amberLight,
            display: "flex",
            fontFamily: "Inter, sans-serif",
            fontSize: compact ? "18px" : "20px",
            fontWeight: 700,
            letterSpacing: "0.24em",
            textTransform: "uppercase",
          }}
        >
          Dazbeez
        </div>
        <div
          style={{
            color: brand.slate,
            display: "flex",
            fontFamily: "Inter, sans-serif",
            fontSize: compact ? "14px" : "16px",
          }}
        >
          AI · Automation · Data Consulting
        </div>
      </div>
    </div>
  );
}

function BackgroundHexes() {
  return (
    <svg
      viewBox="0 0 1200 630"
      aria-hidden="true"
      style={{
        height: "100%",
        left: 0,
        opacity: 0.5,
        position: "absolute",
        top: 0,
        width: "100%",
      }}
    >
      <g fill="none" stroke="rgba(251,191,36,0.16)" strokeWidth="2">
        <polygon points="920,110 980,145 980,215 920,250 860,215 860,145" />
        <polygon points="1020,170 1080,205 1080,275 1020,310 960,275 960,205" />
        <polygon points="1120,110 1180,145 1180,215 1120,250 1060,215 1060,145" />
        <polygon points="950,320 1010,355 1010,425 950,460 890,425 890,355" />
        <polygon points="1090,340 1150,375 1150,445 1090,480 1030,445 1030,375" />
        <polygon points="150,90 195,116 195,168 150,194 105,168 105,116" />
        <polygon points="90,200 135,226 135,278 90,304 45,278 45,226" />
      </g>
    </svg>
  );
}

function SocialVisual({
  accent,
  kind,
}: {
  accent: string;
  kind: SocialVisualKind;
}) {
  const stroke = accent;

  switch (kind) {
    case "services":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <g fill="none" stroke="rgba(249,250,251,0.18)" strokeWidth="1.5">
            <polygon points="110,32 150,55 150,102 110,125 70,102 70,55" />
            <polygon points="195,78 235,101 235,148 195,171 155,148 155,101" />
            <polygon points="110,170 150,193 150,240 110,263 70,240 70,193" />
            <polygon points="240,190 280,213 280,260 240,283 200,260 200,213" />
          </g>
          <g fill="rgba(245,158,11,0.12)" stroke={stroke} strokeWidth="4">
            <polygon points="92,43 128,64 128,94 92,115 56,94 56,64" />
            <polygon points="200,102 236,123 236,153 200,174 164,153 164,123" />
            <polygon points="132,196 168,217 168,247 132,268 96,247 96,217" />
          </g>
          <g stroke={stroke} strokeWidth="5" strokeLinecap="round">
            <path d="M128 79 H164" />
            <path d="M108 115 V191" />
            <path d="M168 247 H200" />
          </g>
          <circle cx="222" cy="224" r="26" fill="#FBBF24" opacity="0.92" />
          <circle cx="222" cy="224" r="12" fill="#111827" />
        </svg>
      );
    case "about":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <circle cx="160" cy="112" r="44" fill="rgba(251,191,36,0.2)" stroke={stroke} strokeWidth="6" />
          <path d="M96 246c18-49 51-74 99-74s82 25 100 74" fill="rgba(245,158,11,0.12)" stroke={stroke} strokeWidth="6" strokeLinecap="round" />
          <circle cx="234" cy="84" r="22" fill="#FBBF24" />
          <polygon points="74,68 98,82 98,110 74,124 50,110 50,82" fill="none" stroke="rgba(249,250,251,0.22)" strokeWidth="5" />
          <path d="M96 112c38 8 68 8 128 0" fill="none" stroke="rgba(249,250,251,0.16)" strokeWidth="4" strokeDasharray="10 12" />
        </svg>
      );
    case "contact":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <rect x="54" y="86" width="166" height="116" rx="28" fill="rgba(245,158,11,0.12)" stroke={stroke} strokeWidth="6" />
          <path d="M82 122l56 40 56-40" fill="none" stroke={stroke} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M232 130c20 10 34 29 34 52s-14 42-34 52" fill="none" stroke="#FBBF24" strokeWidth="8" strokeLinecap="round" />
          <path d="M252 111c33 17 54 40 54 71 0 31-21 54-54 71" fill="none" stroke="rgba(251,191,36,0.4)" strokeWidth="8" strokeLinecap="round" />
          <circle cx="102" cy="242" r="10" fill="#FBBF24" />
          <circle cx="132" cy="242" r="10" fill="rgba(251,191,36,0.55)" />
          <circle cx="162" cy="242" r="10" fill="rgba(251,191,36,0.3)" />
        </svg>
      );
    case "nfc":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <rect x="82" y="48" width="156" height="224" rx="28" fill="rgba(245,158,11,0.1)" stroke={stroke} strokeWidth="6" />
          <rect x="112" y="78" width="96" height="54" rx="16" fill="#FBBF24" opacity="0.92" />
          <rect x="112" y="152" width="96" height="14" rx="7" fill="rgba(249,250,251,0.16)" />
          <rect x="112" y="178" width="96" height="14" rx="7" fill="rgba(249,250,251,0.16)" />
          <rect x="112" y="204" width="62" height="14" rx="7" fill="rgba(249,250,251,0.16)" />
          <path d="M44 122c25 13 42 36 42 62" fill="none" stroke="#FBBF24" strokeWidth="8" strokeLinecap="round" />
          <path d="M24 98c40 21 66 52 66 86" fill="none" stroke="rgba(251,191,36,0.42)" strokeWidth="8" strokeLinecap="round" />
          <circle cx="72" cy="184" r="10" fill={stroke} />
        </svg>
      );
    case "privacy":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <path d="M160 44l74 28v58c0 70-42 116-74 132-32-16-74-62-74-132V72l74-28z" fill="rgba(245,158,11,0.1)" stroke={stroke} strokeWidth="6" strokeLinejoin="round" />
          <rect x="128" y="124" width="64" height="50" rx="12" fill="#FBBF24" />
          <path d="M140 124v-16c0-13 9-24 20-24s20 11 20 24v16" fill="none" stroke="#111827" strokeWidth="6" strokeLinecap="round" />
          <path d="M92 210h136" stroke="rgba(249,250,251,0.18)" strokeWidth="5" strokeLinecap="round" />
          <path d="M112 236h96" stroke="rgba(249,250,251,0.12)" strokeWidth="5" strokeLinecap="round" />
        </svg>
      );
    case "terms":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <rect x="86" y="52" width="122" height="170" rx="22" fill="rgba(245,158,11,0.08)" stroke="rgba(249,250,251,0.16)" strokeWidth="4" />
          <rect x="112" y="78" width="122" height="170" rx="22" fill="rgba(245,158,11,0.12)" stroke={stroke} strokeWidth="6" />
          <path d="M138 114h68" stroke="#FBBF24" strokeWidth="8" strokeLinecap="round" />
          <path d="M138 146h68" stroke="rgba(249,250,251,0.22)" strokeWidth="8" strokeLinecap="round" />
          <path d="M138 178h68" stroke="rgba(249,250,251,0.22)" strokeWidth="8" strokeLinecap="round" />
          <path d="M138 210h48" stroke="rgba(249,250,251,0.22)" strokeWidth="8" strokeLinecap="round" />
          <circle cx="168" cy="268" r="18" fill={stroke} />
        </svg>
      );
    case "twitter":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <ellipse cx="168" cy="168" rx="68" ry="48" fill="#F59E0B" />
          <circle cx="102" cy="160" r="28" fill="#FBBF24" />
          <ellipse cx="166" cy="128" rx="46" ry="22" fill="rgba(249,250,251,0.65)" />
          <ellipse cx="194" cy="120" rx="38" ry="18" fill="rgba(249,250,251,0.4)" />
          <path d="M132 150h92" stroke="#111827" strokeWidth="12" strokeLinecap="round" />
          <path d="M126 184h92" stroke="#111827" strokeWidth="12" strokeLinecap="round" />
          <path d="M222 156l30-14-10 30" fill="#111827" />
          <path d="M92 136l-16-22M110 132l-6-28" stroke="#111827" strokeWidth="6" strokeLinecap="round" />
        </svg>
      );
    case "ai":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <g stroke={stroke} strokeWidth="5" strokeLinecap="round">
            <path d="M92 90l62 34" />
            <path d="M228 90l-62 34" />
            <path d="M92 230l62-34" />
            <path d="M228 230l-62-34" />
            <path d="M160 124v72" />
          </g>
          <g fill="#FBBF24">
            <circle cx="92" cy="90" r="16" />
            <circle cx="228" cy="90" r="16" />
            <circle cx="92" cy="230" r="16" />
            <circle cx="228" cy="230" r="16" />
          </g>
          <circle cx="160" cy="160" r="34" fill="rgba(245,158,11,0.18)" stroke={stroke} strokeWidth="6" />
          <polygon points="160,34 198,56 198,100 160,122 122,100 122,56" fill="none" stroke="rgba(249,250,251,0.16)" strokeWidth="4" />
        </svg>
      );
    case "automation":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <circle cx="132" cy="164" r="54" fill="rgba(245,158,11,0.12)" stroke={stroke} strokeWidth="6" />
          <circle cx="208" cy="164" r="38" fill="rgba(245,158,11,0.08)" stroke="#FBBF24" strokeWidth="6" />
          <circle cx="132" cy="164" r="16" fill="#FBBF24" />
          <circle cx="208" cy="164" r="12" fill={stroke} />
          <path d="M132 92v-22M132 236v22M60 164H38M226 164h22M81 113l-16-16M81 215l-16 16" stroke={stroke} strokeWidth="6" strokeLinecap="round" />
          <path d="M248 132c18 10 30 28 30 48s-12 38-30 48" fill="none" stroke="rgba(251,191,36,0.48)" strokeWidth="8" strokeLinecap="round" />
          <path d="M254 130l20 10-10 18" fill="#FBBF24" />
        </svg>
      );
    case "data":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <ellipse cx="104" cy="98" rx="38" ry="16" fill="rgba(245,158,11,0.18)" stroke={stroke} strokeWidth="5" />
          <path d="M66 98v70c0 9 17 16 38 16s38-7 38-16V98" fill="rgba(245,158,11,0.12)" stroke={stroke} strokeWidth="5" />
          <path d="M66 134c0 9 17 16 38 16s38-7 38-16" fill="none" stroke={stroke} strokeWidth="5" />
          <rect x="180" y="148" width="34" height="76" rx="10" fill="#FBBF24" />
          <rect x="224" y="118" width="34" height="106" rx="10" fill="rgba(251,191,36,0.7)" />
          <rect x="136" y="174" width="34" height="50" rx="10" fill="rgba(251,191,36,0.38)" />
          <path d="M146 246h128" stroke="rgba(249,250,251,0.18)" strokeWidth="5" strokeLinecap="round" />
        </svg>
      );
    case "governance":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <path d="M160 40l78 30v58c0 72-42 120-78 138-36-18-78-66-78-138V70l78-30z" fill="rgba(245,158,11,0.1)" stroke={stroke} strokeWidth="6" strokeLinejoin="round" />
          <g fill="rgba(249,250,251,0.08)" stroke="rgba(249,250,251,0.18)" strokeWidth="3">
            <rect x="110" y="118" width="34" height="34" rx="8" />
            <rect x="160" y="118" width="34" height="34" rx="8" />
            <rect x="110" y="168" width="34" height="34" rx="8" />
            <rect x="160" y="168" width="34" height="34" rx="8" />
          </g>
          <rect x="202" y="142" width="30" height="44" rx="10" fill="#FBBF24" />
          <path d="M210 142v-12c0-10 7-18 14-18s14 8 14 18v12" fill="none" stroke="#111827" strokeWidth="5" strokeLinecap="round" />
        </svg>
      );
    case "pm":
      return (
        <svg viewBox="0 0 320 320" aria-hidden="true" style={{ display: "flex", height: "100%", width: "100%" }}>
          <path d="M54 96h212" stroke="rgba(249,250,251,0.12)" strokeWidth="4" strokeLinecap="round" />
          <path d="M54 156h212" stroke="rgba(249,250,251,0.12)" strokeWidth="4" strokeLinecap="round" />
          <path d="M54 216h212" stroke="rgba(249,250,251,0.12)" strokeWidth="4" strokeLinecap="round" />
          <rect x="64" y="78" width="108" height="34" rx="12" fill="#FBBF24" />
          <rect x="124" y="138" width="124" height="34" rx="12" fill="rgba(251,191,36,0.7)" />
          <rect x="96" y="198" width="86" height="34" rx="12" fill="rgba(251,191,36,0.38)" />
          <circle cx="188" cy="95" r="13" fill={stroke} />
          <polygon points="262,155 274,167 262,179 250,167" fill={stroke} />
          <circle cx="196" cy="215" r="13" fill="#FBBF24" />
        </svg>
      );
  }
}

export function createSocialImage({
  accent = brand.amber,
  eyebrow,
  footer = "dazbeez.com",
  pills = [],
  size,
  subtitle,
  title,
  visual,
}: SocialImageOptions) {
  const compact = size.width < 1000;

  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "stretch",
          background:
            "linear-gradient(135deg, #111827 0%, #1f2937 56%, #111827 100%)",
          color: brand.white,
          display: "flex",
          fontFamily: "Inter, sans-serif",
          height: "100%",
          padding: compact ? "28px" : "52px",
          width: "100%",
        }}
      >
        <div
          style={{
            background:
              "radial-gradient(circle at top left, rgba(245, 158, 11, 0.24), transparent 42%), linear-gradient(145deg, rgba(17,24,39,0.96) 0%, rgba(31,41,55,0.96) 100%)",
            border: "1px solid rgba(245, 158, 11, 0.28)",
            borderRadius: compact ? "28px" : "36px",
            display: "flex",
            flex: 1,
            overflow: "hidden",
            position: "relative",
          }}
        >
          <BackgroundHexes />
          <div
            style={{
              display: "flex",
              flex: 1,
              gap: compact ? "22px" : "36px",
              justifyContent: "space-between",
              padding: compact ? "30px" : "54px",
              position: "relative",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                maxWidth: compact ? "470px" : "720px",
                width: compact ? "62%" : "64%",
              }}
            >
              <BrandLockup compact={compact} />

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: compact ? "16px" : "20px",
                }}
              >
                <div
                  style={{
                    color: brand.amberLight,
                    display: "flex",
                    fontSize: compact ? "16px" : "18px",
                    fontWeight: 700,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                  }}
                >
                  {eyebrow}
                </div>
                <div
                  style={{
                    display: "flex",
                    fontSize: compact ? "50px" : "74px",
                    fontWeight: 800,
                    letterSpacing: "-0.04em",
                    lineHeight: 1.03,
                  }}
                >
                  {title}
                </div>
                <div
                  style={{
                    color: brand.muted,
                    display: "flex",
                    fontSize: compact ? "22px" : "30px",
                    lineHeight: 1.34,
                    maxWidth: compact ? "460px" : "680px",
                  }}
                >
                  {subtitle}
                </div>
              </div>

              <div
                style={{
                  alignItems: "center",
                  display: "flex",
                  gap: compact ? "10px" : "12px",
                  justifyContent: "space-between",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: compact ? "10px" : "12px",
                    maxWidth: compact ? "360px" : "520px",
                  }}
                >
                  {pills.map((pill) => (
                    <div
                      key={pill}
                      style={{
                        background: "rgba(255,255,255,0.06)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: "9999px",
                        color: brand.white,
                        display: "flex",
                        fontSize: compact ? "14px" : "18px",
                        fontWeight: 600,
                        padding: compact ? "8px 14px" : "10px 18px",
                      }}
                    >
                      {pill}
                    </div>
                  ))}
                </div>
                <div
                  style={{
                    color: accent,
                    display: "flex",
                    fontSize: compact ? "16px" : "20px",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  {footer}
                </div>
              </div>
            </div>

            <div
              style={{
                alignItems: "center",
                display: "flex",
                justifyContent: "center",
                width: compact ? "38%" : "32%",
              }}
            >
              <div
                style={{
                  alignItems: "center",
                  background: "rgba(17,24,39,0.52)",
                  border: `1px solid ${accent}40`,
                  borderRadius: compact ? "24px" : "28px",
                  display: "flex",
                  height: compact ? "220px" : "300px",
                  justifyContent: "center",
                  padding: compact ? "18px" : "24px",
                  width: "100%",
                }}
              >
                <SocialVisual accent={accent} kind={visual} />
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
