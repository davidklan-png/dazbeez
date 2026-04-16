import { Suspense } from "react";
import { NFCContent } from "./nfc-content";

export default function NFCPage() {
  return (
    <Suspense fallback={null}>
      <NFCContent />
    </Suspense>
  );
}
