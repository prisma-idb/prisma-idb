import Link from "next/link";
import { BookOpen, ChevronRight, LayoutGrid } from "lucide-react";
import { GetStartedDialog } from "./get-started-dialog";
import { Section, SectionHeader } from "./section";

/** The closing call to action. The quick start itself lives in the docs, where it can show every step. */
export function GetStartedSection() {
  return (
    <Section>
      <SectionHeader eyebrow="Get started" title="Your first query in about ten minutes">
        The quick start walks you through installing the packages, writing a schema, planning the first migration and
        querying IndexedDB from your app.
      </SectionHeader>

      <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
        <GetStartedDialog className="text-brand-foreground inline-flex items-center gap-2 rounded-md bg-[hsl(32,100%,50%)] px-6 py-2.5 text-sm font-medium tracking-wide shadow-md shadow-[hsl(32,100%,50%)]/30 transition-all hover:bg-[hsl(32,100%,45%)] hover:shadow-lg hover:shadow-[hsl(32,100%,50%)]/30">
          <BookOpen className="h-3.5 w-3.5" />
          Get Started
          <ChevronRight className="h-3.5 w-3.5" />
        </GetStartedDialog>
        <Link
          href="/docs/prisma-8/kanban-example"
          className="text-fd-foreground border-fd-border bg-fd-card hover:bg-fd-accent/10 inline-flex items-center gap-2 rounded-md border px-6 py-2.5 text-sm font-medium tracking-wide shadow-sm transition-colors"
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          See a full example app
        </Link>
      </div>
    </Section>
  );
}
