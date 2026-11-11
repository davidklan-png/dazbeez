// Test-only shim for `next/link` in the standalone review-save fixture
// (esbuild-aliased). Renders a plain anchor with the SAME href and forwards
// the SAME onClick the real Link would receive — the guard's
// guardedLinkClick behavior is exercised unmodified. Never imported by the
// app.
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  children: ReactNode;
};

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(
  function Link({ href, children, ...rest }, ref) {
    return (
      <a ref={ref} href={href} {...rest}>
        {children}
      </a>
    );
  },
);

export default Link;
