import { NextResponse } from "next/server";
import { detectBusinessCardsFromImage } from "@/lib/crm-provider";
import { assertAdminPageAccessFromHeaders } from "@/lib/admin-page-auth";

function toDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return `data:${mimeType};base64,${btoa(binary)}`;
}

export async function POST(request: Request) {
  try {
    assertAdminPageAccessFromHeaders(request.headers);
    const formData = await request.formData();
    const file = formData.get("image");
    const expectedCount = Number(formData.get("expectedCount") ?? 9);

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Image file is required." }, { status: 400 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const detections = await detectBusinessCardsFromImage({
      imageDataUrl: toDataUrl(bytes, file.type || "image/png"),
      expectedCount,
    });

    return NextResponse.json({ detections }, { status: 200 });
  } catch (error) {
    console.error("[admin/detect-cards] failed", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Card detection failed.",
      },
      { status: 500 },
    );
  }
}
