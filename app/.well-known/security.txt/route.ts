const SECURITY_TXT = [
  "Contact: mailto:admin@dazbeez.com",
  "Canonical: https://dazbeez.com/.well-known/security.txt",
  "Policy: https://dazbeez.com/privacy-policy",
  "Preferred-Languages: en, ja",
  "Expires: 2030-01-01T00:00:00.000Z",
].join("\n");

export function GET() {
  return new Response(`${SECURITY_TXT}\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
