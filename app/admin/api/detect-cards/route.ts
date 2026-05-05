import { NextResponse } from "next/server";
import { detectBusinessCardsFromImage } from "@/lib/crm-provider";
import { assertAdminPageAccessFromHeaders } from "@/lib/admin-page-auth";
import { getImageSizeValidationError } from "@/lib/crm-upload-limits";

export async function POST(request: Request) {
  try {
    assertAdminPageAccessFromHeaders(request.headers);
    const formData = await request.formData();
    const file = formData.get("image");
    const expectedCount = Number(formData.get("expectedCount") ?? 9);

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Image file is required." }, { status: 400 });
    }

    const sizeError = getImageSizeValidationError({
      fileSize: file.size,
      label: "The composite image",
    });
    if (sizeError) {
      return NextResponse.json({ error: sizeError }, { status: 413 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const detections = await detectBusinessCardsFromImage({
      imageBytes: Array.from(bytes),
      expectedCount,
    });

    if (detections.length === 0) {
      return NextResponse.json(
        {
          error:
            "No business cards were detected in this image. Reframe the photo, reduce glare, or split the cards into smaller groups and try again.",
        },
        { status: 422 },
      );
    }

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
