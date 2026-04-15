import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "What Is This Business Card? | Dazbeez",
  description:
    "A mobile-first explainer for the Dazbeez NFC business card: save contact, capture leads, and keep a useful return path after the event.",
  alternates: {
    canonical: "/business-card",
  },
  openGraph: {
    title: "What Is This Business Card? | Dazbeez",
    description:
      "See how the Dazbeez NFC card turns a tap into contact save, lead capture, and later follow-up.",
    url: "https://dazbeez.com/business-card",
    images: [
      {
        url: "/business-card/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Dazbeez NFC business card explainer",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "What Is This Business Card? | Dazbeez",
    description:
      "See how the Dazbeez NFC card turns a tap into contact save, lead capture, and later follow-up.",
    images: ["/business-card/opengraph-image"],
  },
};

const principles = [
  {
    title: "Save first",
    description:
      "The first action is David's contact card, so a tap immediately gives the visitor something useful.",
    accent: "from-amber-400 to-amber-500",
  },
  {
    title: "Low-friction capture",
    description:
      "Google, LinkedIn, and a manual fallback keep registration fast on mobile without requiring an app install.",
    accent: "from-sky-400 to-sky-500",
  },
  {
    title: "Useful later",
    description:
      "The card stays relevant after the event by routing later taps into services, inquiry, and follow-up context.",
    accent: "from-emerald-400 to-emerald-500",
  },
  {
    title: "Operational visibility",
    description:
      "Contacts, taps, sign-in methods, Discord alerts, and email follow-up are all measurable and recoverable.",
    accent: "from-gray-700 to-gray-900",
  },
];

const touchpoints = [
  {
    title: "1. Tap or scan",
    body: "The card opens a mobile landing page from an NFC tag or QR code.",
    badge: "NFC / QR",
  },
  {
    title: "2. Save the contact",
    body: "The visitor can immediately download David's vCard and keep the relationship.",
    badge: "VCF",
  },
  {
    title: "3. Share their info",
    body: "They register with Google, LinkedIn, or the manual form based on what is easiest on their device.",
    badge: "OAuth",
  },
  {
    title: "4. Follow up later",
    body: "The same card can later answer 'what do you do?' and route into services, inquiry, or LinkedIn.",
    badge: "Return tap",
  },
];

const architecture = [
  {
    title: "Physical card",
    caption: "NFC tag + QR code",
    detail: "One tokenized URL lives on the card so every tap starts in the same place.",
  },
  {
    title: "Landing flow",
    caption: "hi.dazbeez.com",
    detail: "Cloudflare Pages serves the landing page, vCard, OAuth callbacks, and thank-you flow.",
  },
  {
    title: "Lead capture",
    caption: "D1 + contact events",
    detail: "Contacts dedupe by person, while every registration method is still logged as its own event.",
  },
  {
    title: "Notifications",
    caption: "Discord + email",
    detail: "Successful captures trigger Discord alerts and a follow-up email with a return path.",
  },
  {
    title: "Main site",
    caption: "dazbeez.com",
    detail: "Later taps and admin review connect back into services, inquiry, and the internal dashboard.",
  },
];

export default function BusinessCardPage() {
  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#111827_0%,#18202d_22%,#f7f4ea_22%,#fffdf7_100%)]">
      <section className="relative overflow-hidden text-white">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(245,158,11,0.28),transparent_36%),radial-gradient(circle_at_left,rgba(251,191,36,0.15),transparent_30%)]" />
        <div className="relative mx-auto flex max-w-6xl flex-col gap-10 px-4 py-14 sm:px-6 lg:flex-row lg:items-center lg:gap-16 lg:px-8 lg:py-20">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-300">
              What Is This Business Card?
            </p>
            <h1 className="mt-4 text-4xl font-bold leading-tight sm:text-5xl">
              A reusable digital business card designed for the first tap and the next tap.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-gray-300 sm:text-lg">
              It is not just a link sticker. The card is a small mobile workflow:
              save David&apos;s contact, share yours with minimal friction, and keep a
              useful path back into Dazbeez after the event.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="https://hi.dazbeez.com/hi/jKR9S31l"
                className="inline-flex items-center justify-center rounded-full bg-amber-500 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-600"
              >
                Open a live example
              </Link>
              <Link
                href="/inquiry"
                className="inline-flex items-center justify-center rounded-full border border-white/20 px-6 py-3 text-sm font-semibold text-white transition-colors hover:border-white/40"
              >
                Start an inquiry
              </Link>
            </div>
          </div>

          <div className="w-full max-w-md lg:ml-auto">
            <div className="rounded-[2rem] border border-white/10 bg-white/8 p-3 shadow-2xl backdrop-blur">
              <div className="rounded-[1.6rem] bg-[#fffaf0] p-5 text-gray-900">
                <div className="rounded-[1.4rem] bg-[linear-gradient(135deg,#fbbf24_0%,#f59e0b_100%)] p-5 text-white shadow-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.24em] text-amber-100">
                        Dazbeez Card
                      </p>
                      <h2 className="mt-2 text-2xl font-bold">David Klan</h2>
                    </div>
                    <div className="grid h-16 w-16 place-items-center rounded-2xl bg-white/20 text-3xl">
                      🐝
                    </div>
                  </div>
                  <p className="mt-4 text-sm text-amber-50">
                    Save contact, connect on LinkedIn, or register in one mobile flow.
                  </p>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-2xl border border-amber-100 bg-white p-4 shadow-sm">
                    <div className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">
                      First tap
                    </div>
                    <div className="mt-2 font-semibold text-gray-900">Save my contact</div>
                    <div className="mt-1 text-gray-500">Useful immediately</div>
                  </div>
                  <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">
                      Next step
                    </div>
                    <div className="mt-2 font-semibold text-gray-900">Share your info</div>
                    <div className="mt-1 text-gray-500">Google, LinkedIn, manual</div>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">Tap again later</div>
                      <div className="text-sm text-gray-500">
                        Services, inquiry, LinkedIn, and card explanation
                      </div>
                    </div>
                    <div className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                      Reusable
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="rounded-[2rem] border border-amber-100 bg-white p-6 shadow-[0_24px_80px_-40px_rgba(17,24,39,0.35)] sm:p-8">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-600">
              Mobile Experience
            </p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900">
              The flow is optimized for a standing conversation, not a desktop form.
            </h2>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {touchpoints.map((item) => (
              <article
                key={item.title}
                className="rounded-[1.5rem] border border-gray-200 bg-[linear-gradient(180deg,#ffffff_0%,#fff8e6_100%)] p-5 shadow-sm"
              >
                <span className="inline-flex rounded-full bg-gray-900 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-white">
                  {item.badge}
                </span>
                <h3 className="mt-4 text-xl font-semibold text-gray-900">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-gray-600">{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-2 sm:px-6 lg:px-8">
        <div className="rounded-[2rem] bg-gray-900 px-6 py-8 text-white sm:px-8">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-300">
              Architecture
            </p>
            <h2 className="mt-3 text-3xl font-bold">
              A small event card backed by a production lead-capture system.
            </h2>
          </div>

          <div className="mt-8 grid gap-4 lg:grid-cols-5">
            {architecture.map((item, index) => (
              <div key={item.title} className="relative">
                <article className="h-full rounded-[1.5rem] border border-white/10 bg-white/5 p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">
                    {item.caption}
                  </div>
                  <h3 className="mt-3 text-xl font-semibold">{item.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-gray-300">{item.detail}</p>
                </article>
                {index < architecture.length - 1 ? (
                  <div className="pointer-events-none hidden lg:flex absolute right-[-18px] top-1/2 h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-amber-500 text-white shadow-lg">
                    →
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {principles.map((item) => (
            <article
              key={item.title}
              className="overflow-hidden rounded-[1.75rem] border border-gray-200 bg-white shadow-sm"
            >
              <div className={`h-2 bg-gradient-to-r ${item.accent}`} />
              <div className="p-6">
                <h3 className="text-xl font-semibold text-gray-900">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-gray-600">{item.description}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="pb-16">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="rounded-[2rem] border border-amber-200 bg-[linear-gradient(135deg,#fff8e6_0%,#ffffff_65%)] p-8 text-center shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.32em] text-amber-600">
              Why it matters
            </p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900">
              The card works as a physical introduction and a digital re-entry point.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-gray-600">
              That is the design choice underneath everything else: make the event
              interaction easy now, but keep the object useful when the buyer has
              context later.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Link
                href="https://hi.dazbeez.com/hi/jKR9S31l"
                className="inline-flex items-center justify-center rounded-full bg-gray-900 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-gray-800"
              >
                Try the card flow
              </Link>
              <Link
                href="/services"
                className="inline-flex items-center justify-center rounded-full border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-900 transition-colors hover:border-gray-500"
              >
                Explore services
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
