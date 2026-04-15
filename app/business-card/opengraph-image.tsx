import { ImageResponse } from "next/og";

export const alt = "Dazbeez NFC business card explainer";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          background:
            "linear-gradient(135deg, #111827 0%, #18202d 44%, #f7f4ea 44%, #fffdf7 100%)",
          color: "#111827",
          padding: "42px",
        }}
      >
        <div
          style={{
            display: "flex",
            width: "100%",
            borderRadius: "34px",
            overflow: "hidden",
            boxShadow: "0 30px 100px rgba(17, 24, 39, 0.25)",
            border: "1px solid rgba(245, 158, 11, 0.18)",
            background: "#ffffff",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              width: "58%",
              padding: "48px",
              background:
                "radial-gradient(circle at top right, rgba(245, 158, 11, 0.20), transparent 36%), linear-gradient(180deg, #111827 0%, #1f2937 100%)",
              color: "#f9fafb",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "18px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  width: "74px",
                  height: "74px",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "9999px",
                  background: "linear-gradient(135deg, #fbbf24, #f59e0b)",
                  color: "#111827",
                  fontSize: "34px",
                  fontWeight: 800,
                }}
              >
                D
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    fontSize: "20px",
                    fontWeight: 700,
                    letterSpacing: "0.24em",
                    textTransform: "uppercase",
                    color: "#fbbf24",
                  }}
                >
                  Dazbeez NFC
                </div>
                <div
                  style={{
                    display: "flex",
                    fontSize: "18px",
                    color: "#cbd5e1",
                  }}
                >
                  Business card explainer
                </div>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "18px",
                maxWidth: "560px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: "64px",
                  lineHeight: 1.02,
                  fontWeight: 800,
                }}
              >
                First tap now.
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: "64px",
                  lineHeight: 1.02,
                  fontWeight: 800,
                  color: "#fbbf24",
                }}
              >
                Better tap later.
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: "26px",
                  lineHeight: 1.35,
                  color: "#d1d5db",
                }}
              >
                Save contact, capture leads, and keep a reusable path back into services and inquiry.
              </div>
            </div>

            <div
              style={{
                display: "flex",
                gap: "14px",
              }}
            >
              {["Save", "Connect", "Return"].map((label) => (
                <div
                  key={label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "12px 20px",
                    borderRadius: "9999px",
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    fontSize: "20px",
                    fontWeight: 700,
                    color: "#f9fafb",
                  }}
                >
                  {label}
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: "42%",
              padding: "36px",
              background:
                "linear-gradient(180deg, rgba(255,250,240,1) 0%, rgba(255,255,255,1) 100%)",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                borderRadius: "30px",
                padding: "24px",
                background: "#fff7e0",
                border: "1px solid #fde68a",
                boxShadow: "0 12px 34px rgba(17, 24, 39, 0.08)",
                gap: "18px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      fontSize: "16px",
                      fontWeight: 700,
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                      color: "#b45309",
                    }}
                  >
                    Dazbeez card
                  </div>
                  <div
                    style={{
                      display: "flex",
                      fontSize: "32px",
                      fontWeight: 800,
                      color: "#111827",
                    }}
                  >
                    David Klan
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    width: "66px",
                    height: "66px",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "22px",
                    background: "linear-gradient(135deg, #fbbf24, #f59e0b)",
                    fontSize: "30px",
                  }}
                >
                  🐝
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                {[
                  ["1", "Tap or scan"],
                  ["2", "Save contact"],
                  ["3", "Share your info"],
                  ["4", "Tap again later"],
                ].map(([step, label]) => (
                  <div
                    key={step}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "14px",
                      padding: "12px 14px",
                      borderRadius: "18px",
                      background: "#ffffff",
                      border: "1px solid #e5e7eb",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        width: "34px",
                        height: "34px",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: "9999px",
                        background: "#111827",
                        color: "#ffffff",
                        fontSize: "18px",
                        fontWeight: 800,
                      }}
                    >
                      {step}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        fontSize: "24px",
                        fontWeight: 700,
                        color: "#1f2937",
                      }}
                    >
                      {label}
                    </div>
                  </div>
                ))}
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "14px",
                }}
              >
                {[
                  ["Cloudflare", "#1d4ed8"],
                  ["D1", "#0f766e"],
                  ["Discord", "#7c3aed"],
                ].map(([label, color]) => (
                  <div
                    key={label}
                    style={{
                      display: "flex",
                      flex: 1,
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: "16px",
                      background: "#ffffff",
                      border: "1px solid #e5e7eb",
                      padding: "12px 10px",
                      color,
                      fontSize: "19px",
                      fontWeight: 700,
                    }}
                  >
                    {label}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
