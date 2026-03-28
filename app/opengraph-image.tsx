import { ImageResponse } from "next/og";

export const alt = "Dazbeez AI, Automation & Data Solutions";
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
          alignItems: "stretch",
          background:
            "linear-gradient(135deg, #111827 0%, #1f2937 58%, #111827 100%)",
          color: "#f9fafb",
          display: "flex",
          height: "100%",
          padding: "56px",
          width: "100%",
        }}
      >
        <div
          style={{
            border: "1px solid rgba(245, 158, 11, 0.3)",
            borderRadius: "36px",
            display: "flex",
            flex: 1,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background:
                "radial-gradient(circle at top left, rgba(245, 158, 11, 0.28), transparent 55%)",
              display: "flex",
              flex: 1,
              flexDirection: "column",
              justifyContent: "space-between",
              padding: "56px",
            }}
          >
            <div
              style={{
                alignItems: "center",
                display: "flex",
                gap: "20px",
              }}
            >
              <div
                style={{
                  alignItems: "center",
                  background: "linear-gradient(135deg, #fbbf24, #d97706)",
                  borderRadius: "9999px",
                  color: "#111827",
                  display: "flex",
                  fontSize: "34px",
                  fontWeight: 800,
                  height: "84px",
                  justifyContent: "center",
                  width: "84px",
                }}
              >
                D
              </div>
              <div
                style={{
                  color: "#fbbf24",
                  display: "flex",
                  fontSize: "34px",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                Dazbeez
              </div>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "22px",
                maxWidth: "760px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: "76px",
                  fontWeight: 800,
                  lineHeight: 1.05,
                }}
              >
                AI, Automation & Data Solutions
              </div>
              <div
                style={{
                  color: "#d1d5db",
                  display: "flex",
                  fontSize: "30px",
                  lineHeight: 1.35,
                }}
              >
                Strategy, delivery, and modern data systems for businesses that
                need practical transformation.
              </div>
            </div>

            <div
              style={{
                color: "#fbbf24",
                display: "flex",
                fontSize: "24px",
                fontWeight: 600,
                letterSpacing: "0.04em",
              }}
            >
              dazbeez.com
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
