"use client";

import { useEffect, useState } from "react";
import { Star, Download } from "lucide-react";

interface Stats {
  stars: number | null;
  downloads: number | null;
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return n.toLocaleString();
}

export function SocialProof() {
  const [stats, setStats] = useState<Stats>({ stars: null, downloads: null });

  useEffect(() => {
    const controller = new AbortController();

    Promise.allSettled([
      fetch("https://api.github.com/repos/prisma-idb/prisma-idb", {
        signal: controller.signal,
      }).then((r) => r.json()),
      fetch("https://api.npmjs.org/downloads/point/last-week/@prisma-idb/idb-client-generator", {
        signal: controller.signal,
      }).then((r) => r.json()),
    ]).then(([ghResult, npmResult]) => {
      if (controller.signal.aborted) return;
      const rawStars = ghResult.status === "fulfilled" ? ghResult.value.stargazers_count : undefined;
      const rawDownloads = npmResult.status === "fulfilled" ? npmResult.value.downloads : undefined;
      setStats({
        stars: typeof rawStars === "number" && Number.isFinite(rawStars) ? rawStars : null,
        downloads: typeof rawDownloads === "number" && Number.isFinite(rawDownloads) ? rawDownloads : null,
      });
    });

    return () => controller.abort();
  }, []);

  return (
    <div className="flex items-center justify-center gap-3 text-sm">
      <a
        href="https://github.com/prisma-idb/prisma-idb"
        target="_blank"
        rel="noopener noreferrer"
        className="text-fd-muted-foreground hover:text-fd-foreground inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-4 py-1.5 shadow-sm transition-colors dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-none"
      >
        <Star className="h-3.5 w-3.5 text-amber-500" />
        {stats.stars !== null ? (
          <span>{formatNumber(stats.stars)} stars</span>
        ) : (
          <span className="bg-fd-muted inline-block h-5 w-14 animate-pulse rounded" />
        )}
      </a>
      <a
        href="https://www.npmjs.com/package/@prisma-idb/idb-client-generator"
        target="_blank"
        rel="noopener noreferrer"
        className="text-fd-muted-foreground hover:text-fd-foreground inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-4 py-1.5 shadow-sm transition-colors dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-none"
      >
        <Download className="h-3.5 w-3.5 text-emerald-500" />
        {stats.downloads !== null ? (
          <span>{formatNumber(stats.downloads)}/wk</span>
        ) : (
          <span className="bg-fd-muted inline-block h-5 w-14 animate-pulse rounded" />
        )}
      </a>
    </div>
  );
}
