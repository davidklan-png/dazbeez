import { NextResponse } from "next/server";
import { assertAdminPageAccessFromHeaders, getAdminPageUsernameFromHeaders } from "@/lib/admin-page-auth";
import { createBusinessCardBatch } from "@/lib/crm";
import { extractBusinessCardDetails } from "@/lib/crm-provider";
import type { CardDetectionCandidate } from "@/lib/crm-types";
import { getImageSizeValidationError } from "@/lib/crm-upload-limits";

type CropManifestEntry = {
  fieldName: string;
  label: string;
  detection: CardDetectionCandidate;
  width?: number | null;
  height?: number | null;
};

export async function POST(request: Request) {
  try {
    assertAdminPageAccessFromHeaders(request.headers);
    const actor = getAdminPageUsernameFromHeaders(request.headers) ?? "admin";
    const formData = await request.formData();

    const compositeImage = formData.get("compositeImage");
    const manifestRaw = String(formData.get("cropManifest") ?? "[]");
    const detectionsRaw = String(formData.get("detections") ?? "[]");
    const manifest = JSON.parse(manifestRaw) as CropManifestEntry[];
    const detections = JSON.parse(detectionsRaw) as CardDetectionCandidate[];

    if (!(compositeImage instanceof File)) {
      return NextResponse.json({ error: "Composite image is required." }, { status: 400 });
    }

    if (detections.length === 0 || manifest.length === 0) {
      return NextResponse.json(
        {
          error:
            "No detected cards were attached to this batch. Run detection again and verify the image before creating the batch.",
        },
        { status: 422 },
      );
    }

    if (manifest.length !== detections.length) {
      return NextResponse.json(
        {
          error:
            "Detected cards and cropped cards are out of sync. Run detection again before creating the batch.",
        },
        { status: 422 },
      );
    }

    const compositeSizeError = getImageSizeValidationError({
      fileSize: compositeImage.size,
      label: "The composite image",
    });
    if (compositeSizeError) {
      return NextResponse.json({ error: compositeSizeError }, { status: 413 });
    }

    const compositeBytes = new Uint8Array(await compositeImage.arrayBuffer());
    const crops = [];

    for (const entry of manifest) {
      const cropFile = formData.get(entry.fieldName);
      if (!(cropFile instanceof File)) {
        continue;
      }

      const cropSizeError = getImageSizeValidationError({
        fileSize: cropFile.size,
        label: `Cropped card ${entry.label}`,
      });
      if (cropSizeError) {
        return NextResponse.json({ error: cropSizeError }, { status: 413 });
      }

      const cropBytes = new Uint8Array(await cropFile.arrayBuffer());
      const extracted = await extractBusinessCardDetails({
        imageBytes: Array.from(cropBytes),
        eventContext: [formData.get("eventName"), formData.get("eventLocation")]
          .filter(Boolean)
          .join(" / "),
      });

      crops.push({
        label: entry.label,
        detection: entry.detection,
        image: {
          fileName: cropFile.name || `${entry.label}.png`,
          mimeType: cropFile.type || "image/png",
          bytes: cropBytes,
          width: entry.width ?? null,
          height: entry.height ?? null,
          metadata: {
            sourceField: entry.fieldName,
            detection: entry.detection,
          },
        },
        extracted,
      });
    }

    const batchId = await createBusinessCardBatch({
      actor,
      compositeImage: {
        fileName: compositeImage.name || "batch-upload.png",
        mimeType: compositeImage.type || "image/png",
        bytes: compositeBytes,
        metadata: {
          uploadedVia: "admin_api",
        },
      },
      detections,
      crops,
      eventName: String(formData.get("eventName") ?? "") || null,
      eventDate: String(formData.get("eventDate") ?? "") || null,
      eventLocation: String(formData.get("eventLocation") ?? "") || null,
      notesAboutConversations: String(formData.get("notesAboutConversations") ?? "") || null,
      campaignTag: String(formData.get("campaignTag") ?? "") || null,
      expectedCardCount: Number(formData.get("expectedCardCount") ?? 9),
    });

    return NextResponse.json({ batchId }, { status: 200 });
  } catch (error) {
    console.error("[admin/batches] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Batch ingestion failed." },
      { status: 500 },
    );
  }
}
