import { NextResponse } from "next/server";
import { assertAdminPageAccessFromHeaders } from "@/lib/admin-page-auth";
import { getImageBlob } from "@/lib/crm";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertAdminPageAccessFromHeaders(request.headers);
    const { id } = await params;
    const imageId = Number(id);
    if (!Number.isInteger(imageId) || imageId <= 0) {
      return new NextResponse("Invalid image id.", { status: 400 });
    }

    const image = await getImageBlob(imageId);
    if (!image) {
      return new NextResponse("Image not found.", { status: 404 });
    }

    const body = Uint8Array.from(image.blob).buffer;
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": image.mimeType,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "Unable to load image.", {
      status: 500,
    });
  }
}
