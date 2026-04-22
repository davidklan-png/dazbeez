"use client";

import { useState } from "react";
import { polygonToBounds } from "@/lib/crm-card-geometry";
import type { CardDetectionCandidate } from "@/lib/crm-types";

type CropResult = {
  file: File;
  width: number;
  height: number;
  label: string;
  detection: CardDetectionCandidate;
};

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not load the uploaded image."));
    };
    image.src = objectUrl;
  });
}

async function cropDetectedCards(file: File, detections: CardDetectionCandidate[]): Promise<CropResult[]> {
  const image = await loadImage(file);

  return Promise.all(
    detections.map(async (detection, index) => {
      const bounds = polygonToBounds(detection.polygon);
      const sx = Math.max(0, Math.floor(bounds.x * image.naturalWidth));
      const sy = Math.max(0, Math.floor(bounds.y * image.naturalHeight));
      const sw = Math.max(1, Math.floor(bounds.width * image.naturalWidth));
      const sh = Math.max(1, Math.floor(bounds.height * image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Canvas 2D context is unavailable in this browser.");
      }

      context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => {
          if (!value) {
            reject(new Error("Failed to generate a cropped card image."));
            return;
          }

          resolve(value);
        }, "image/png");
      });

      return {
        file: new File([blob], `card-${index + 1}.png`, { type: "image/png" }),
        width: sw,
        height: sh,
        label: detection.label || `card_${index + 1}`,
        detection,
      };
    }),
  );
}

export function BatchUploadForm() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [eventName, setEventName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventLocation, setEventLocation] = useState("");
  const [notesAboutConversations, setNotesAboutConversations] = useState("");
  const [campaignTag, setCampaignTag] = useState("");
  const [expectedCardCount, setExpectedCardCount] = useState("9");
  const [processingState, setProcessingState] = useState<"idle" | "detecting" | "uploading">("idle");
  const [detectedCount, setDetectedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!imageFile) {
      setError("Select a composite image before starting the batch.");
      return;
    }

    try {
      setProcessingState("detecting");
      const detectionForm = new FormData();
      detectionForm.set("image", imageFile);
      detectionForm.set("expectedCount", expectedCardCount || "9");

      const detectionResponse = await fetch("/admin/api/detect-cards", {
        method: "POST",
        body: detectionForm,
      });

      const detectionPayload = (await detectionResponse.json()) as {
        detections?: CardDetectionCandidate[];
        error?: string;
      };

      if (!detectionResponse.ok || !detectionPayload.detections) {
        throw new Error(detectionPayload.error || "Card detection failed.");
      }

      setDetectedCount(detectionPayload.detections.length);

      const crops = await cropDetectedCards(imageFile, detectionPayload.detections);
      const uploadForm = new FormData();
      uploadForm.set("compositeImage", imageFile);
      uploadForm.set("eventName", eventName);
      uploadForm.set("eventDate", eventDate);
      uploadForm.set("eventLocation", eventLocation);
      uploadForm.set("notesAboutConversations", notesAboutConversations);
      uploadForm.set("campaignTag", campaignTag);
      uploadForm.set("expectedCardCount", expectedCardCount || "9");
      uploadForm.set("detections", JSON.stringify(detectionPayload.detections));
      uploadForm.set(
        "cropManifest",
        JSON.stringify(
          crops.map((crop, index) => ({
            fieldName: `crop_${index}`,
            label: crop.label,
            detection: crop.detection,
            width: crop.width,
            height: crop.height,
          })),
        ),
      );

      crops.forEach((crop, index) => {
        uploadForm.set(`crop_${index}`, crop.file);
      });

      setProcessingState("uploading");
      const uploadResponse = await fetch("/admin/api/batches", {
        method: "POST",
        body: uploadForm,
      });

      const uploadPayload = (await uploadResponse.json()) as {
        batchId?: number;
        error?: string;
      };

      if (!uploadResponse.ok || !uploadPayload.batchId) {
        throw new Error(uploadPayload.error || "Batch upload failed.");
      }

      window.location.assign(`/admin/batches/${uploadPayload.batchId}`);
    } catch (submitError) {
      setProcessingState("idle");
      setError(submitError instanceof Error ? submitError.message : "Batch upload failed.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Composite image</span>
          <input
            type="file"
            accept=".jpg,.jpeg,.png,image/jpeg,image/png"
            onChange={(event) => setImageFile(event.target.files?.[0] ?? null)}
            className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Expected card count</span>
          <input
            type="number"
            min={1}
            max={24}
            value={expectedCardCount}
            onChange={(event) => setExpectedCardCount(event.target.value)}
            className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Event name</span>
          <input
            value={eventName}
            onChange={(event) => setEventName(event.target.value)}
            className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900"
            placeholder="Tokyo AI Meetup"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Event date</span>
          <input
            type="date"
            value={eventDate}
            onChange={(event) => setEventDate(event.target.value)}
            className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Event location</span>
          <input
            value={eventLocation}
            onChange={(event) => setEventLocation(event.target.value)}
            className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900"
            placeholder="Tokyo"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Campaign tag</span>
          <input
            value={campaignTag}
            onChange={(event) => setCampaignTag(event.target.value)}
            className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900"
            placeholder="spring-networking"
          />
        </label>
      </div>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Notes about conversations</span>
        <textarea
          value={notesAboutConversations}
          onChange={(event) => setNotesAboutConversations(event.target.value)}
          rows={4}
          className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900"
          placeholder="Great discussion about bilingual workflows and practical AI adoption."
        />
      </label>

      {detectedCount !== null ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Last detection pass found {detectedCount} cards.
        </div>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={processingState !== "idle"}
          className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {processingState === "detecting"
            ? "Detecting cards..."
            : processingState === "uploading"
              ? "Creating batch..."
              : "Start processing"}
        </button>
        <p className="text-sm text-gray-500">
          Upload one composite image and create a reviewable CRM batch.
        </p>
      </div>
    </form>
  );
}
