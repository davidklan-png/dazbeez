import Link from "next/link";

export function InlineServerError({
  where,
  error,
}: {
  where: string;
  error: unknown;
}) {
  const err = error instanceof Error ? error : new Error(String(error));
  const stack = err.stack ?? "(no stack)";
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-12 text-center">
      <div className="max-w-2xl rounded-2xl border border-red-200 bg-red-50 p-6 text-left">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-red-700">
          Receipts · server render error
        </div>
        <div className="mt-2 text-lg font-semibold text-gray-900">
          {where} crashed while rendering on the server.
        </div>
        <p className="mt-2 text-sm text-gray-600">
          Full exception below. Also logged to{" "}
          <code className="font-mono">wrangler tail</code>.
        </p>
        <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-white p-3 font-mono text-[12px] text-red-700">
          {err.name}: {err.message}
          {"\n\n"}
          {stack}
        </pre>
        <div className="mt-4 flex gap-2">
          <Link
            href="/receipts"
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

export function isNextInternalError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const digest = (err as { digest?: unknown }).digest;
  if (typeof digest !== "string") return false;
  return (
    digest === "NEXT_NOT_FOUND" ||
    digest.startsWith("NEXT_REDIRECT") ||
    digest.startsWith("NEXT_HTTP_ERROR_FALLBACK")
  );
}
