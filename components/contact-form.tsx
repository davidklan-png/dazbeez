"use client";

import { useMemo, useState } from "react";
import { serviceList, type ServiceSlug } from "@/lib/services";

type FieldErrors = Partial<Record<"firstName" | "lastName" | "email" | "phoneNumber" | "message" | "service", string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Props = {
  defaultService?: string;
  headline?: string;
  eyebrow?: string;
  source?: string;
};

export function ContactForm({
  defaultService = "",
  headline = "Tell us what you\u2019re trying to build.",
  eyebrow = "Contact",
  source,
}: Props) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [service, setService] = useState<string>(defaultService);
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");

  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [serverError, setServerError] = useState<string>("");

  const serviceOptions = useMemo(
    () => [...serviceList.map((s) => ({ value: s.slug as ServiceSlug, label: s.title })), { value: "other" as const, label: "Something else" }],
    [],
  );

  function clientValidate(): FieldErrors {
    const next: FieldErrors = {};
    if (!firstName.trim()) next.firstName = "First name is required.";
    if (!lastName.trim()) next.lastName = "Last name is required.";
    if (!email.trim()) next.email = "Email is required.";
    else if (!EMAIL_RE.test(email.trim())) next.email = "Enter a valid email address.";
    if (phoneNumber.trim().length > 20) next.phoneNumber = "Phone number is too long.";
    if (!message.trim()) next.message = "Message is required.";
    else if (message.trim().length < 10) next.message = "Please add a few more details.";
    return next;
  }

  function resetForm() {
    setFirstName("");
    setLastName("");
    setEmail("");
    setCompany("");
    setPhoneNumber("");
    setService(defaultService);
    setMessage("");
    setWebsite("");
    setErrors({});
    setServerError("");
    setStatus("idle");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError("");
    const next = clientValidate();
    setErrors(next);
    if (Object.keys(next).length > 0) {
      setStatus("idle");
      return;
    }

    setStatus("pending");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          company: company.trim(),
          phoneNumber: phoneNumber.trim(),
          service,
          message: message.trim(),
          website,
          source,
        }),
      });

      if (res.ok) {
        setStatus("success");
        return;
      }

      const body = await res.json().catch(() => ({}));
      if (res.status === 400 && body?.errors) {
        setErrors(body.errors as FieldErrors);
        setStatus("idle");
        return;
      }
      setServerError(body?.error ?? "Something went wrong. Please try again.");
      setStatus("error");
    } catch {
      setServerError("Network error. Please check your connection and try again.");
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div className="max-w-md w-full mx-auto text-center">
        <div className="bg-white rounded-2xl shadow-xl border border-gray-200 p-8">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Message sent.</h2>
          <p className="text-gray-600 mb-6">We&apos;ll get back to you within 24 hours.</p>
          <button
            type="button"
            onClick={resetForm}
            className="inline-flex items-center justify-center px-6 py-2 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
          >
            Send another message
          </button>
          <p className="mt-4 text-sm text-gray-600">
            <a
              href="https://www.linkedin.com/in/david-klan"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-amber-600 transition-colors hover:text-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
            >
              Or connect on LinkedIn
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-xl border border-gray-200 p-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.32em] text-amber-600 mb-2">
          {eyebrow}
        </p>
        <h2 className="text-2xl font-bold text-gray-900">{headline}</h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
        <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
          <label htmlFor="website">Website</label>
          <input
            id="website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <TextField
            id="firstName"
            label="First name"
            required
            value={firstName}
            onChange={setFirstName}
            error={errors.firstName}
            autoComplete="given-name"
          />
          <TextField
            id="lastName"
            label="Last name"
            required
            value={lastName}
            onChange={setLastName}
            error={errors.lastName}
            autoComplete="family-name"
          />
        </div>

        <TextField
          id="email"
          label="Email"
          type="email"
          required
          value={email}
          onChange={setEmail}
          error={errors.email}
          placeholder="you@example.com"
          autoComplete="email"
        />

        <TextField
          id="company"
          label="Company"
          value={company}
          onChange={setCompany}
          placeholder="Your company name"
          autoComplete="organization"
          optional
        />

        <TextField
          id="phoneNumber"
          label="Phone"
          type="tel"
          value={phoneNumber}
          onChange={setPhoneNumber}
          error={errors.phoneNumber}
          autoComplete="tel"
          optional
          maxLength={20}
        />

        <div>
          <label htmlFor="service" className="block text-sm font-medium text-gray-700 mb-1">
            What do you need help with?
          </label>
          <select
            id="service"
            value={service}
            onChange={(e) => setService(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent bg-white"
            aria-invalid={errors.service ? true : undefined}
            aria-describedby={errors.service ? "service-error" : undefined}
          >
            <option value="">Not sure yet</option>
            {serviceOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {errors.service && (
            <p id="service-error" className="mt-1 text-sm text-red-600">
              {errors.service}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-1">
            Message <span aria-hidden="true" className="text-red-500">*</span>
          </label>
          <textarea
            id="message"
            rows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent resize-none"
            placeholder="Tell us about the outcome you need and any constraints (timeline, regulations, existing stack)."
            aria-required="true"
            aria-invalid={errors.message ? true : undefined}
            aria-describedby={errors.message ? "message-error" : undefined}
            maxLength={4000}
          />
          <div className="mt-1 flex items-start justify-between gap-3">
            {errors.message ? (
              <p id="message-error" className="text-sm text-red-600" role="alert">
                {errors.message}
              </p>
            ) : (
              <span />
            )}
            <p className="text-xs text-gray-400">{message.length} / 4000</p>
          </div>
        </div>

        {serverError && (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {serverError}
          </div>
        )}

        <button
          type="submit"
          disabled={status === "pending"}
          className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
        >
          {status === "pending" ? (
            <>
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Sending…
            </>
          ) : (
            "Send message"
          )}
        </button>
      </form>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  type = "text",
  required = false,
  optional = false,
  placeholder,
  autoComplete,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  type?: string;
  required?: boolean;
  optional?: boolean;
  placeholder?: string;
  autoComplete?: string;
  maxLength?: number;
}) {
  const describedBy = error ? `${id}-error` : undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">
        {label}{" "}
        {required && <span aria-hidden="true" className="text-red-500">*</span>}
        {optional && <span className="text-gray-400 font-normal">(optional)</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent"
        placeholder={placeholder}
        autoComplete={autoComplete}
        maxLength={maxLength}
        aria-required={required ? true : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {error && (
        <p id={describedBy} className="mt-1 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
