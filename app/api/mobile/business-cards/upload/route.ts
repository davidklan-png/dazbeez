import { NextResponse } from "next/server";
import { createMobileBusinessCardCapture } from "@/lib/crm";
import { extractBusinessCardDetails } from "@/lib/crm-provider";
import { getImageSizeValidationError } from "@/lib/crm-upload-limits";
import { requireMobileActor } from "@/lib/receipts/trusted-devices";

export async function POST(request: Request) {
  try {
    const device = await requireMobileActor(request.headers, "business_card:create");

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A file is required." }, { status: 400 });
    }

    const sizeError = getImageSizeValidationError({
      fileSize: file.size,
      label: "Business card image",
    });
    if (sizeError) {
      return NextResponse.json({ error: sizeError }, { status: 413 });
    }

    const clientCaptureId = formData.get("client_capture_id")?.toString().trim();
    if (!clientCaptureId) {
      return NextResponse.json(
        { error: "client_capture_id is required." },
        { status: 400 },
      );
    }
    const rawBatchId = formData.get("batch_id")?.toString().trim();
    const batchId = rawBatchId ? Number(rawBatchId) : null;
    if (rawBatchId && (!Number.isInteger(batchId) || (batchId as number) < 1)) {
      return NextResponse.json({ error: "batch_id must be a positive integer." }, { status: 400 });
    }
    const eventName = formData.get("event_name")?.toString().slice(0, 200) || null;
    if (!batchId && !eventName) {
      return NextResponse.json(
        { error: "event_name is required when no batch_id is provided." },
        { status: 400 },
      );
    }
    const capturedAtClient =
      formData.get("captured_at_client")?.toString().trim() || null;
    const appVersion = formData.get("app_version")?.toString().slice(0, 32) || null;
    const note = formData.get("note")?.toString().slice(0, 1000) || null;

    const bytes = new Uint8Array(await file.arrayBuffer());

    // Extract the card details inline. Mobile uploads send a clean cropped
    // image from VisionKit, so we run extraction once per upload (no
    // composite-then-crop step). The result lands in batch_cards via
    // insertBatchCard.
    const extracted = await extractBusinessCardDetails({
      imageBytes: Array.from(bytes),
      eventContext: eventName ?? null,
    });

    const result = await createMobileBusinessCardCapture({
      actor: device.actor,
      deviceId: device.deviceId,
      clientCaptureId,
      capturedAtClient,
      appVersion,
      note,
      batchId,
      eventName,
      image: {
        fileName: file.name || `${clientCaptureId}.jpg`,
        mimeType: file.type || "image/jpeg",
        bytes,
        width: null,
        height: null,
        metadata: null,
      },
      extracted,
    });

    return NextResponse.json(
      {
        ok: true,
        duplicate: result.duplicate,
        batchId: result.batchId,
        batchCardId: result.batchCardId,
        businessCardImageId: result.businessCardImageId,
        reviewUrl: `/admin/batches/${result.batchId}`,
      },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof Error && error.message.startsWith("Forbidden")) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("[api/mobile/business-cards/upload] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 },
    );
  }
}
