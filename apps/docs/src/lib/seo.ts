import type { Metadata } from "next";
import type { InferPageType } from "fumadocs-core/source";
import { getPageImage, type source } from "@/lib/source";

/**
 * Origin that serves the docs; the canonical host and scheme for every page.
 * It has no trailing slash because Next writes the root canonical and `og:url` that way,
 * and the sitemap root must match them.
 */
export const siteUrl = "https://prisma-idb.dev";

/** Name shown as the Open Graph site name and in the document title template. */
export const siteName = "Prisma IDB";

type DocsPage = InferPageType<typeof source>;

/**
 * Returns the heading for a docs page's `<title>`.
 *
 * The Prisma 8 section reuses titles from the original docs (for example "Quick Start"),
 * so its pages carry a suffix. Without it, two pages would share one title.
 */
function pageTitle(page: DocsPage): string {
  const isPrisma8 = page.slugs[0] === "prisma-8";
  return isPrisma8 && !page.data.title.includes("Prisma 8") ? `${page.data.title} (Prisma 8)` : page.data.title;
}

/**
 * Builds the per-page metadata for a docs page: title, description, a self-referencing
 * canonical URL, and Open Graph and Twitter tags.
 *
 * The canonical path is relative; Next resolves it against `metadataBase` in the root layout.
 * This function sets `openGraph` and `twitter` in full because Next replaces, rather than
 * merges, those objects from the root layout.
 */
export function docsPageMetadata(page: DocsPage): Metadata {
  const title = pageTitle(page);
  const description = page.data.description;
  const image = { url: getPageImage(page).url, width: 1200, height: 630, alt: title };

  return {
    title,
    description,
    alternates: { canonical: page.url },
    openGraph: { type: "article", siteName, url: page.url, title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  };
}
