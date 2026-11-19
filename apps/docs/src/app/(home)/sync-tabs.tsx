"use client";

import { type ReactNode, useState } from "react";
import Link from "next/link";

const tabs = [
  { id: "schema", label: "1. Schema" },
  { id: "endpoints", label: "2. Endpoints" },
  { id: "worker", label: "3. Worker" },
] as const;

type TabId = (typeof tabs)[number]["id"];

interface SyncTabsProps {
  schemaBlock: ReactNode;
  endpointsBlock: ReactNode;
  workerBlock: ReactNode;
}

export function SyncTabs({ schemaBlock, endpointsBlock, workerBlock }: SyncTabsProps) {
  const [active, setActive] = useState<TabId>("schema");

  const tabContent: Record<TabId, ReactNode> = {
    schema: schemaBlock,
    endpoints: endpointsBlock,
    worker: workerBlock,
  };

  return (
    <div>
      <div className="border-fd-border flex gap-1 overflow-x-auto rounded-t-xl border border-b-0 bg-zinc-100 p-1.5 shadow-sm dark:bg-zinc-900/80 dark:shadow-none">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={`shrink-0 rounded-md px-3.5 py-1.5 text-[13px] font-medium transition-all ${
              active === tab.id
                ? "bg-white text-[hsl(32,100%,50%)] shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-950 dark:ring-white/8"
                : "text-fd-muted-foreground hover:text-fd-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="[&_figure]:m-0! [&_figure]:rounded-t-none! [&_figure]:border-t-0!">{tabContent[active]}</div>
      <p className="text-fd-muted-foreground mt-4 text-center text-sm">
        Three steps to full sync.{" "}
        <Link href="/docs/prisma-8/sync" className="text-fd-accent hover:underline">
          Full setup guide &rarr;
        </Link>
      </p>
    </div>
  );
}
