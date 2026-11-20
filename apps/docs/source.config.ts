import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

// `seoTitle` and `seoDescription` override the `<title>` and meta description without changing the
// heading and subtitle shown on the page. Search results need the IndexedDB context that a reader
// gets from the sidebar; without it, a page titled "findMany" reads like a copy of Prisma's docs.
// Both reuse the optional `description` string schema because Zod is not a direct dependency here.
const optionalString = pageSchema.shape.description;

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema.extend({ seoTitle: optionalString, seoDescription: optionalString }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMdxMermaid],
  },
});
