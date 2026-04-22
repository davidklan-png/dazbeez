import { NextResponse } from "next/server";
import { appendSubmission } from "@/lib/contact-submissions";
import { savePublicContactSubmissionToCrm } from "@/lib/crm";
import { isServiceSlug } from "@/lib/services";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Errors = Partial<Record<"firstName" | "lastName" | "email" | "phoneNumber" | "message" | "service", string>>;

function validate(body: Record<string, unknown>): { ok: true; data: Parameters<typeof appendSubmission>[0] } | { ok: false; errors: Errors } {
  const errors: Errors = {};

  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const phoneNumber = typeof body.phoneNumber === "string" ? body.phoneNumber.trim() : "";
  const service = typeof body.service === "string" ? body.service.trim() : "";
  const source = typeof body.source === "string" ? body.source.trim() : "";

  if (!firstName) errors.firstName = "First name is required.";
  else if (firstName.length > 80) errors.firstName = "First name is too long.";

  if (!lastName) errors.lastName = "Last name is required.";
  else if (lastName.length > 80) errors.lastName = "Last name is too long.";

  if (!email) errors.email = "Email is required.";
  else if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  else if (email.length > 160) errors.email = "Email is too long.";

  if (phoneNumber.length > 20) errors.phoneNumber = "Phone number is too long.";

  if (!message) errors.message = "Message is required.";
  else if (message.length < 10) errors.message = "Please add a few more details (at least 10 characters).";
  else if (message.length > 4000) errors.message = "Message is too long (max 4000 characters).";

  if (service && service !== "other" && !isServiceSlug(service)) {
    errors.service = "Unknown service selection.";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      firstName,
      lastName,
      email,
      company: company || undefined,
      phoneNumber: phoneNumber || undefined,
      service: service || undefined,
      message,
      source: source || undefined,
      submittedAt: new Date().toISOString(),
    },
  };
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const website = typeof body.website === "string" ? body.website.trim() : "";
  if (website) {
    return NextResponse.json({ ok: true }, { status: 400 });
  }

  const result = validate(body);
  if (!result.ok) {
    return NextResponse.json({ errors: result.errors }, { status: 400 });
  }

  try {
    await appendSubmission(result.data);
    await savePublicContactSubmissionToCrm({
      actor: "public_contact_form",
      firstName: result.data.firstName,
      lastName: result.data.lastName,
      email: result.data.email,
      company: result.data.company,
      phoneNumber: result.data.phoneNumber,
      service: result.data.service,
      message: result.data.message,
      source: result.data.source,
    });
  } catch (err) {
    console.error("[contact] failed to persist submission", err);
    return NextResponse.json(
      { error: "Could not save your message. Please email us directly at hello@dazbeez.com." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
