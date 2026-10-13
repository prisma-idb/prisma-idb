/**
 * Checks the SEO metadata of the statically exported docs in `out/`.
 *
 * Run `next build` first, then `pnpm seo:check`. The script fails when:
 * - a sitemap URL has no exported page, or an exported page is missing from the sitemap;
 * - a page lacks a title, a meta description, a canonical link or the Open Graph basics;
 * - a page's canonical URL differs from its sitemap URL;
 * - two pages share a title or a description.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("../out", import.meta.url));
const siteUrl = "https://prisma-idb.dev";

/** Lists the HTML files for pages, skipping Next's internal `_`-prefixed output and error pages. */
function listPageFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name.startsWith("_") || name === "404.html") return [];
    if (statSync(path).isDirectory()) return listPageFiles(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

/** Maps an exported HTML file to its canonical URL. Next writes the root without a trailing slash. */
function urlForFile(file) {
  const path = "/" + relative(outDir, file).replace(/\.html$/, "");
  return path === "/index" ? siteUrl : `${siteUrl}${path}`;
}

/** Returns the first match of `pattern` in `html`, with HTML entities decoded, or `undefined`. */
function extract(html, pattern) {
  const value = html.match(pattern)?.[1];
  return value?.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#x27;", "'").trim();
}

/** Reads the `content` of a `<meta>` tag found by its `name` or `property` attribute. */
function metaContent(html, attribute, key) {
  return extract(html, new RegExp(`<meta ${attribute}="${key}" content="([^"]*)"`));
}

const sitemap = readFileSync(join(outDir, "sitemap.xml"), "utf8");
const sitemapUrls = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]));
const pages = listPageFiles(outDir).map((file) => {
  const html = readFileSync(file, "utf8");
  return {
    url: urlForFile(file),
    title: extract(html, /<title>([^<]*)<\/title>/),
    description: metaContent(html, "name", "description"),
    canonical: extract(html, /<link rel="canonical" href="([^"]*)"/),
    ogTitle: metaContent(html, "property", "og:title"),
    ogDescription: metaContent(html, "property", "og:description"),
    ogUrl: metaContent(html, "property", "og:url"),
    ogImage: metaContent(html, "property", "og:image"),
  };
});

const problems = [];
for (const url of sitemapUrls) {
  if (!pages.some((page) => page.url === url)) problems.push(`${url}: in the sitemap but not exported`);
}
for (const page of pages) {
  if (!sitemapUrls.has(page.url)) problems.push(`${page.url}: exported but not in the sitemap`);
  for (const field of ["title", "description", "canonical", "ogTitle", "ogDescription", "ogUrl", "ogImage"]) {
    if (!page[field]) problems.push(`${page.url}: missing ${field}`);
  }
  if (page.canonical && page.canonical !== page.url) problems.push(`${page.url}: canonical is ${page.canonical}`);
  if (page.ogUrl && page.ogUrl !== page.url) problems.push(`${page.url}: og:url is ${page.ogUrl}`);
}
for (const field of ["title", "description"]) {
  const urlsByValue = Map.groupBy(
    pages.filter((page) => page[field]),
    (page) => page[field]
  );
  for (const [value, group] of urlsByValue) {
    if (group.length > 1) problems.push(`duplicate ${field} "${value}": ${group.map((page) => page.url).join(", ")}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`SEO check passed for ${pages.length} pages.`);
