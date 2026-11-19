import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

/** One landing page section: the same divider, spacing and width everywhere, so the page reads as one flow. */
export function Section({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`border-fd-border/60 border-t px-6 py-20 sm:py-28 lg:px-8 ${className}`}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </section>
  );
}

interface SectionHeaderProps {
  /** A short label above the title, naming the topic. */
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  align?: "center" | "left";
}

export function SectionHeader({ eyebrow, title, children, align = "center" }: SectionHeaderProps) {
  const centered = align === "center";
  return (
    <div className={centered ? "mx-auto mb-12 max-w-2xl text-center sm:mb-14" : "mb-8 max-w-xl"}>
      <p
        className={`${GeistMono.className} mb-4 text-xs font-medium tracking-[0.12em] text-[hsl(32,100%,38%)] uppercase dark:text-[hsl(32,100%,55%)]`}
      >
        {eyebrow}
      </p>
      <h2
        className={`${GeistSans.className} text-fd-foreground text-3xl leading-tight font-bold tracking-tight sm:text-4xl`}
      >
        {title}
      </h2>
      {children && <div className="text-fd-muted-foreground mt-4 text-base leading-relaxed sm:text-lg">{children}</div>}
    </div>
  );
}
