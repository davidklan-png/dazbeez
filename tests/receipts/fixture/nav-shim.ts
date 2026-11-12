// Test-only shim for `next/navigation` in the standalone review-save fixture
// (esbuild-aliased). The REAL form/queue/guard code runs unmodified; only the
// router is recorded so navigation targets become assertable. This file is
// never imported by the app.

export const navLog: string[] = [];

export function useRouter() {
  return {
    push: (url: string) => {
      navLog.push(`push ${url}`);
    },
    refresh: () => {
      navLog.push("refresh");
    },
    replace: (url: string) => {
      navLog.push(`replace ${url}`);
    },
    back: () => {
      navLog.push("back");
    },
    prefetch: () => {},
  };
}

export function useSearchParams() {
  return new URLSearchParams("");
}

export function usePathname() {
  return "/receipts/review/fixture";
}

export function useParams() {
  return { id: "r-fixture-1" };
}
