import { NextResponse } from "next/server";

export const runtime = "edge";

const CRLF = "\r\n";

/**
 * Minimal vCard 3.0 contact for David Klan. Pointed at by the
 * /business-card and /nfc pages so visitors can save the contact without
 * leaving dazbeez.com. Keep this in sync with the canonical card hosted
 * at hi.dazbeez.com.
 */
const VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Klan;David;;;",
  "FN:David Klan",
  "ORG:Dazbeez",
  "TITLE:Founder — AI, Automation & Data",
  "EMAIL;TYPE=INTERNET,PREF:david@dazbeez.com",
  "URL:https://dazbeez.com",
  "URL;TYPE=card:https://dazbeez.com/business-card",
  "END:VCARD",
].join(CRLF);

export function GET() {
  return new NextResponse(VCARD, {
    status: 200,
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": 'attachment; filename="david-klan.vcf"',
      "Cache-Control": "public, max-age=300",
    },
  });
}
