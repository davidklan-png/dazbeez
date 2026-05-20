import { NextResponse } from "next/server";
import { createPairingCode } from "@/lib/receipts/mobile-pairing";

// Public endpoint — the iPhone has no token yet at this stage. The bearer
// token is only ever delivered through /check after the pairing code is
// consumed by an operator behind Cloudflare Access.
export async function POST() {
  try {
    const { code, expiresAt } = await createPairingCode();
    return NextResponse.json({ code, expiresAt }, { status: 201 });
  } catch (error) {
    console.error("[api/mobile/auth/start-pairing] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Pairing setup failed." },
      { status: 500 },
    );
  }
}
