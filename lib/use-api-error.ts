"use client";

import { useCallback } from "react";
import { useToast } from "@/components/ui/toaster";

export type ApiErrorKind =
  | "network"
  | "auth"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation"
  | "server"
  | "unknown";

export type ApiError = {
  kind: ApiErrorKind;
  status: number | null;
  message: string;
  /** Original raw JSON body, when available. */
  body?: unknown;
};

/**
 * Classify a fetch Response (or thrown error) into a typed ApiError so
 * UI code can branch on `.kind` instead of substring-matching `.message`.
 */
export async function classifyResponse(
  res: Response | null,
  err?: unknown,
): Promise<ApiError> {
  if (!res) {
    return {
      kind: "network",
      status: null,
      message:
        err instanceof Error ? err.message : "Network error — please try again.",
    };
  }

  let body: unknown;
  let message: string | undefined;
  try {
    body = await res.clone().json();
    if (body && typeof body === "object") {
      const maybe = body as { error?: unknown; message?: unknown };
      if (typeof maybe.error === "string") message = maybe.error;
      else if (typeof maybe.message === "string") message = maybe.message;
    }
  } catch {
    /* non-json body */
  }

  const fallback = message ?? `Request failed (HTTP ${res.status}).`;

  if (res.status === 401)
    return { kind: "auth", status: res.status, message: fallback, body };
  if (res.status === 403)
    return { kind: "forbidden", status: res.status, message: fallback, body };
  if (res.status === 404)
    return { kind: "not_found", status: res.status, message: fallback, body };
  if (res.status === 409)
    return { kind: "conflict", status: res.status, message: fallback, body };
  if (res.status === 422)
    return { kind: "validation", status: res.status, message: fallback, body };
  if (res.status >= 500)
    return { kind: "server", status: res.status, message: fallback, body };
  return { kind: "unknown", status: res.status, message: fallback, body };
}

const TITLES: Record<ApiErrorKind, string> = {
  network: "Network error",
  auth: "Sign-in expired",
  forbidden: "Not allowed",
  not_found: "Not found",
  conflict: "Conflict",
  validation: "Validation failed",
  server: "Server error",
  unknown: "Request failed",
};

/**
 * One-liner for reporting an ApiError to the toast surface from any
 * client component. Returns a function so callers can keep their
 * `try { await fetch(...) } catch (e) { reportApiError(e) }` shape.
 */
export function useApiError() {
  const { toast } = useToast();
  return useCallback(
    (err: ApiError, opts?: { fallbackTitle?: string }) => {
      toast({
        tone: "error",
        title: opts?.fallbackTitle ?? TITLES[err.kind],
        body: err.message,
      });
    },
    [toast],
  );
}

/**
 * Thin fetch wrapper that returns either `{ ok: true, data }` or
 * `{ ok: false, error }`. Removes the boilerplate of manually parsing
 * each response status. Use from client components only.
 */
export async function apiFetch<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    return { ok: false, error: await classifyResponse(null, err) };
  }
  if (!res.ok) {
    return { ok: false, error: await classifyResponse(res) };
  }
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { ok: true, data: data as T };
}
