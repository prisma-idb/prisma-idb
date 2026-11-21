import { GeistMono } from "geist/font/mono";
import { ArrowUpRight } from "lucide-react";
import { Section, SectionHeader } from "./section";

interface Mention {
  /** The publication or post, as its own title gives it. */
  name: string;
  /** Month and year of the mention. */
  date: string;
  /** One factual line on what the mention says about the project. */
  summary: string;
  href: string;
}

// Newest last. Describe each mention in our own words rather than quoting a person.
const mentions: Mention[] = [
  {
    name: "Prisma ORM Manifesto 2026",
    date: "Oct 2026",
    summary:
      "Prisma names the IndexedDB extension one of two standout community extensions, built without the core team's involvement.",
    href: "https://www.prisma.io/blog/prisma-orm-manifesto-2026",
  },
  {
    name: "Local-First News",
    date: "Nov 2026",
    summary: "Listed under Tools & Resources in the November 19 edition of the local-first newsletter.",
    href: "https://www.localfirstnews.com/2026-11-19/",
  },
];

export function FeaturedSection() {
  return (
    <Section>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-16">
        <SectionHeader eyebrow="In the wild" title="Noticed by the people building local-first." align="left">
          Write-ups and mentions from around the Prisma and local-first communities.
        </SectionHeader>

        <ul className="divide-fd-border/60 border-fd-border/60 divide-y border-y">
          {mentions.map((mention) => (
            <li key={mention.href}>
              <a
                href={mention.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group grid grid-cols-[minmax(0,1fr)_1.25rem] gap-x-4 gap-y-1 py-6 sm:grid-cols-[5.5rem_minmax(0,1fr)_1.25rem] sm:gap-x-6 sm:py-7"
              >
                <span
                  className={`${GeistMono.className} text-fd-muted-foreground col-span-2 text-xs sm:col-span-1 sm:pt-1.5 sm:text-[13px]`}
                >
                  {mention.date}
                </span>
                <span className="flex flex-col gap-2">
                  <span className="text-fd-foreground group-hover:text-brand-text text-lg font-semibold transition-colors sm:text-xl">
                    {mention.name}
                  </span>
                  <span className="text-fd-muted-foreground text-[15px] leading-relaxed">{mention.summary}</span>
                </span>
                <ArrowUpRight
                  className="text-fd-muted-foreground group-hover:text-brand-text mt-1 h-5 w-5 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                  aria-hidden="true"
                />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
