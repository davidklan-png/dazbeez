import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { sendDraftEmailAction, updateDraftEmailAction } from "@/app/admin/crm-actions";
import { getContactDetail } from "@/lib/crm";

export const metadata: Metadata = {
  title: "Contact Detail — Dazbeez Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AdminContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const contact = await getContactDetail(Number(id));
  if (!contact) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-600">{contact.contact.source}</p>
        <h2 className="mt-2 text-2xl font-semibold text-gray-900">{contact.contact.name}</h2>
        <p className="mt-2 text-sm text-gray-500">
          {[contact.contact.jobTitle, contact.contact.company].filter(Boolean).join(" · ") || "No title or company captured"}
        </p>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-gray-900">Identity</h3>
            <dl className="mt-4 grid gap-4 md:grid-cols-2 text-sm">
              <div><dt className="text-gray-500">Email</dt><dd className="mt-1 text-gray-900">{contact.contact.email || "—"}</dd></div>
              <div><dt className="text-gray-500">Phone</dt><dd className="mt-1 text-gray-900">{contact.contact.phone || contact.contact.mobile || "—"}</dd></div>
              <div><dt className="text-gray-500">LinkedIn</dt><dd className="mt-1 break-all text-gray-900">{contact.contact.linkedinUrl || "—"}</dd></div>
              <div><dt className="text-gray-500">Website</dt><dd className="mt-1 break-all text-gray-900">{contact.contact.website || "—"}</dd></div>
              <div><dt className="text-gray-500">Native name</dt><dd className="mt-1 text-gray-900">{contact.contact.fullNameNative || "—"}</dd></div>
              <div><dt className="text-gray-500">Department</dt><dd className="mt-1 text-gray-900">{contact.contact.department || "—"}</dd></div>
            </dl>
            {contact.contact.rawOcrText ? (
              <div className="mt-6">
                <h4 className="text-sm font-semibold text-gray-900">Raw OCR text</h4>
                <pre className="mt-2 overflow-x-auto rounded-xl bg-gray-50 p-4 text-xs leading-6 text-gray-700">
                  {contact.contact.rawOcrText}
                </pre>
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-gray-900">Enrichment facts</h3>
            <div className="mt-4 space-y-3">
              {contact.enrichmentFacts.length > 0 ? (
                contact.enrichmentFacts.map((fact, index) => (
                  <div key={`${fact.label}-${index}`} className="rounded-xl border border-gray-100 px-4 py-3">
                    <p className="font-medium text-gray-900">{fact.label}</p>
                    <p className="mt-1 text-sm text-gray-700">{fact.value}</p>
                    <a href={fact.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-amber-700 hover:text-amber-800">
                      {fact.sourceTitle || fact.sourceUrl}
                    </a>
                  </div>
                ))
              ) : (
                <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-sm text-gray-500">
                  No enrichment facts stored yet.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-gray-900">Draft emails</h3>
            <div className="mt-4 space-y-4">
              {contact.drafts.length > 0 ? (
                contact.drafts.map((draft) => (
                  <div key={draft.id} className="rounded-xl border border-gray-100 p-4">
                    <div className="flex items-center justify-between gap-4">
                      <p className="font-medium text-gray-900">{draft.subjectLine}</p>
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold capitalize text-gray-700">
                          {draft.status}
                        </span>
                        {draft.status === "approved" ? (
                          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
                            Sent
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-gray-500">{draft.rationaleSummary}</p>
                    {draft.status !== "approved" && draft.status !== "archived" ? (
                      <form action={updateDraftEmailAction} className="mt-3 space-y-3">
                        <input type="hidden" name="draftId" value={String(draft.id)} />
                        <div className="space-y-1.5">
                          <label htmlFor={`draft-subject-${draft.id}`} className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                            Subject
                          </label>
                          <input
                            id={`draft-subject-${draft.id}`}
                            name="subjectLine"
                            type="text"
                            defaultValue={draft.subjectLine}
                            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                            required
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label htmlFor={`draft-body-${draft.id}`} className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                            Body
                          </label>
                          <textarea
                            id={`draft-body-${draft.id}`}
                            name="plainTextBody"
                            defaultValue={draft.plainTextBody}
                            rows={12}
                            className="w-full rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs leading-6 text-gray-700 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                            required
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="submit"
                            className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-amber-200 hover:bg-amber-50 hover:text-amber-700"
                          >
                            Save Draft
                          </button>
                          <button
                            type="submit"
                            formAction={sendDraftEmailAction}
                            className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600"
                          >
                            Save + Send
                          </button>
                        </div>
                      </form>
                    ) : (
                      <pre className="mt-3 overflow-x-auto rounded-xl bg-gray-50 p-4 text-xs leading-6 text-gray-700">
                        {draft.plainTextBody}
                      </pre>
                    )}
                  </div>
                ))
              ) : (
                <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-sm text-gray-500">
                  No drafts generated yet.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          {contact.images.length > 0 ? (
            <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
              <h3 className="text-lg font-semibold text-gray-900">Card images</h3>
              <div className="mt-4 space-y-4">
                {contact.images.map((image) => (
                  <div key={image.id} className="overflow-hidden rounded-2xl border border-gray-100 bg-gray-50 p-3">
                    <Image
                      src={`/admin/images/${image.id}`}
                      alt={`Contact image ${image.id}`}
                      width={500}
                      height={320}
                      className="h-auto w-full rounded-xl object-contain"
                      unoptimized
                    />
                    <p className="mt-2 text-xs text-gray-500">{image.role}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-gray-900">Synergy analysis</h3>
            {contact.synergy ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-xl bg-amber-50 px-4 py-3">
                  <p className="text-sm text-amber-900">Score: {contact.synergy.synergyScore}/100</p>
                  <p className="mt-2 text-sm text-gray-700">{contact.synergy.synergySummary}</p>
                </div>
                <div className="space-y-3">
                  {contact.synergy.reasons.map((reason, index) => (
                    <div key={`${reason.title}-${index}`} className="rounded-xl border border-gray-100 px-4 py-3">
                      <p className="font-medium text-gray-900">{reason.title}</p>
                      <p className="mt-1 text-sm text-gray-700">{reason.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded-xl border border-dashed border-gray-200 px-4 py-6 text-sm text-gray-500">
                No synergy analysis saved yet.
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-gray-900">Activity & audit</h3>
            <div className="mt-4 space-y-3 text-sm">
              {contact.events.map((event) => (
                <div key={`event-${event.id}`} className="rounded-xl border border-gray-100 px-4 py-3">
                  <p className="font-medium text-gray-900">{event.eventType.replaceAll("_", " ")}</p>
                  <p className="mt-1 text-gray-600">{event.summary || event.source}</p>
                  <p className="mt-1 text-xs text-gray-500">{event.createdAt}</p>
                </div>
              ))}
              {contact.auditLog.map((entry) => (
                <div key={`audit-${entry.id}`} className="rounded-xl border border-gray-100 px-4 py-3">
                  <p className="font-medium text-gray-900">{entry.action}</p>
                  <p className="mt-1 text-gray-600">{entry.actor}</p>
                  <p className="mt-1 text-xs text-gray-500">{entry.createdAt}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
