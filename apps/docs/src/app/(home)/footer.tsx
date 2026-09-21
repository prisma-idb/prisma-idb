import Link from "next/link";
import { Star } from "lucide-react";

const GITHUB_URL = "https://github.com/prisma-idb/prisma-idb";

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

const footerLinks: Record<string, FooterLink[]> = {
  "Get Started": [
    { label: "Quick Start", href: "/docs/quick-start" },
    { label: "Sync Guide", href: "/docs/sync" },
    { label: "API Reference", href: "/docs" },
  ],
  Project: [
    { label: "GitHub", href: GITHUB_URL, external: true },
    { label: "npm", href: "https://www.npmjs.com/package/@prisma-idb/idb-client-generator", external: true },
    { label: "Live Demo", href: "https://kanban.prisma-idb.dev/", external: true },
  ],
};

export function Footer() {
  return (
    <footer className="border-fd-border/60 border-t px-6 py-12 lg:px-8">
      <div className="mx-auto max-w-5xl space-y-10">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
          {/* CTA */}
          <div className="space-y-4">
            <p className="text-fd-foreground text-sm font-semibold">Open Source</p>
            <p className="text-fd-muted-foreground text-sm leading-relaxed">
              Prisma IDB is free and open source. Contributions and feedback are welcome.
            </p>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:shadow-none dark:hover:bg-zinc-900"
            >
              <Star className="h-3.5 w-3.5" />
              Star on GitHub
            </a>
          </div>

          {/* Link columns */}
          {Object.entries(footerLinks).map(([heading, links]) => (
            <div key={heading}>
              <p className="text-fd-foreground mb-3 text-sm font-semibold">{heading}</p>
              <ul className="space-y-2">
                {links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-fd-muted-foreground hover:text-fd-foreground text-sm transition-colors"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-fd-muted-foreground hover:text-fd-foreground text-sm transition-colors"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-fd-border/60 space-y-3 border-t pt-8">
          <p className="text-fd-muted-foreground text-xs leading-relaxed">
            Prisma is a trademark of Prisma. Prisma IDB is an independent open-source project and is not affiliated
            with, endorsed by, or sponsored by Prisma.
          </p>
          <p className="text-fd-muted-foreground text-xs">© {new Date().getFullYear()} Prisma IDB</p>
        </div>
      </div>
    </footer>
  );
}
