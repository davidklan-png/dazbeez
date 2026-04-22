import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { processApprovedBatchAction, saveBatchCardReviewAction } from "@/app/admin/crm-actions";
import { getBatchDetail } from "@/lib/crm";

export const metadata: Metadata = {
  title: "Batch Detail — Dazbeez Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function DetailField({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue: string | null;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">{label}</span>
      <input
        name={name}
        defaultValue={defaultValue ?? ""}
        className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900"
      />
    </label>
  );
}

export default async function AdminBatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const batchId = Number(id);
  const batch = Number.isInteger(batchId) ? await getBatchDetail(batchId) : null;
  if (!batch) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-600">Batch #{batch.batch.id}</p>
            <h2 className="mt-2 text-2xl font-semibold text-gray-900">
              {batch.batch.eventName || "Untitled business-card batch"}
            </h2>
            <p className="mt-2 text-sm leading-7 text-gray-500">
              {[batch.batch.eventDate, batch.batch.eventLocation].filter(Boolean).join(" · ") || "No event metadata"}.
              {" "}
              {batch.batch.detectedCardCount ?? 0} detected cards, {batch.batch.needsReviewCount} review items.
            </p>
            {batch.batch.notesAboutConversations ? (
              <p className="mt-3 rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-600">
                {batch.batch.notesAboutConversations}
              </p>
            ) : null}
          </div>
          <form action={processApprovedBatchAction}>
            <input type="hidden" name="batchId" value={String(batch.batch.id)} />
            <button
              type="submit"
              className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600"
            >
              Create or update contacts + drafts
            </button>
          </form>
        </div>

        {batch.batch.originalImageId ? (
          <div className="mt-6 overflow-hidden rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <Image
              src={`/admin/images/${batch.batch.originalImageId}`}
              alt={`Original upload for batch ${batch.batch.id}`}
              width={1200}
              height={900}
              className="h-auto w-full rounded-xl object-contain"
              unoptimized
            />
          </div>
        ) : null}
      </section>

      <section className="space-y-4">
        {batch.cards.map((card) => (
          <article key={card.id} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-6 xl:flex-row">
              <div className="w-full xl:w-72">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-gray-900">
                    Card {card.sortOrder + 1}
                  </h3>
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold capitalize text-amber-800">
                    {card.status}
                  </span>
                </div>
                {card.croppedImageId ? (
                  <div className="mt-4 overflow-hidden rounded-2xl border border-gray-100 bg-gray-50 p-3">
                    <Image
                      src={`/admin/images/${card.croppedImageId}`}
                      alt={`Cropped business card ${card.sortOrder + 1}`}
                      width={480}
                      height={280}
                      className="h-auto w-full rounded-xl object-contain"
                      unoptimized
                    />
                  </div>
                ) : null}
                <dl className="mt-4 space-y-2 text-sm text-gray-600">
                  <div className="flex justify-between gap-3">
                    <dt>Detection confidence</dt>
                    <dd>{card.detectionConfidence ? `${Math.round(card.detectionConfidence * 100)}%` : "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Linked contact</dt>
                    <dd>{card.contactId ?? "New"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Review required</dt>
                    <dd>{card.needsReview ? "Yes" : "No"}</dd>
                  </div>
                </dl>
              </div>

              <div className="min-w-0 flex-1">
                <form action={saveBatchCardReviewAction} className="space-y-4">
                  <input type="hidden" name="batchId" value={String(batch.batch.id)} />
                  <input type="hidden" name="batchCardId" value={String(card.id)} />
                  <input type="hidden" name="confidenceJson" value={JSON.stringify(card.confidence)} />

                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    <DetailField name="full_name" label="Full Name" defaultValue={card.normalized.full_name} />
                    <DetailField name="first_name" label="First Name" defaultValue={card.normalized.first_name} />
                    <DetailField name="last_name" label="Last Name" defaultValue={card.normalized.last_name} />
                    <DetailField name="full_name_native" label="Native Name" defaultValue={card.normalized.full_name_native} />
                    <DetailField name="furigana" label="Furigana" defaultValue={card.normalized.furigana ?? null} />
                    <DetailField name="job_title" label="Job Title" defaultValue={card.normalized.job_title} />
                    <DetailField name="department" label="Department" defaultValue={card.normalized.department} />
                    <DetailField name="company_name" label="Company" defaultValue={card.normalized.company_name} />
                    <DetailField name="company_name_native" label="Native Company" defaultValue={card.normalized.company_name_native} />
                    <DetailField name="email" label="Email" defaultValue={card.normalized.email} />
                    <DetailField name="phone" label="Phone" defaultValue={card.normalized.phone} />
                    <DetailField name="mobile" label="Mobile" defaultValue={card.normalized.mobile} />
                    <DetailField name="website" label="Website" defaultValue={card.normalized.website} />
                    <DetailField name="linkedin_url" label="LinkedIn" defaultValue={card.normalized.linkedin_url} />
                    <DetailField name="postal_code" label="Postal Code" defaultValue={card.normalized.postal_code} />
                    <DetailField name="city" label="City" defaultValue={card.normalized.city} />
                    <DetailField name="state_prefecture" label="State / Prefecture" defaultValue={card.normalized.state_prefecture} />
                    <DetailField name="country" label="Country" defaultValue={card.normalized.country} />
                  </div>

                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">Address</span>
                    <textarea
                      name="address"
                      defaultValue={card.normalized.address ?? ""}
                      rows={2}
                      className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">Notes From Card</span>
                    <textarea
                      name="notes_from_card"
                      defaultValue={card.normalized.notes_from_card ?? ""}
                      rows={2}
                      className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">Raw OCR Text</span>
                    <textarea
                      name="raw_ocr_text"
                      defaultValue={card.rawOcrText ?? ""}
                      rows={5}
                      className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900"
                    />
                  </label>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block">
                      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">Use existing contact</span>
                      <select
                        name="sourceContactId"
                        defaultValue={card.sourceContactId ? String(card.sourceContactId) : ""}
                        className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900"
                      >
                        <option value="">Create new contact</option>
                        {card.duplicateCandidates.map((candidate) => (
                          <option key={candidate.contactId} value={String(candidate.contactId)}>
                            #{candidate.contactId} · {Math.round(candidate.confidence * 100)}% · {candidate.reasons.join(", ")}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block">
                      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">Mark invalid</span>
                      <input
                        name="invalidReason"
                        defaultValue={card.invalidReason ?? ""}
                        placeholder="Use when this crop is not a valid card."
                        className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900"
                      />
                    </label>
                  </div>

                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">Reviewer Notes</span>
                    <textarea
                      name="notes"
                      defaultValue={card.notes ?? ""}
                      rows={2}
                      className="mt-2 block w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900"
                    />
                  </label>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="submit"
                      name="markApproved"
                      value="true"
                      className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600"
                    >
                      Save and approve
                    </button>
                    <button
                      type="submit"
                      name="markApproved"
                      value="false"
                      className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
                    >
                      Save for later
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
