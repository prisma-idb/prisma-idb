const entities = { "&amp;": "&", "&quot;": '"', "&#x27;": "'" };

/**
 * Decodes the HTML entities that Next escapes in metadata attributes.
 *
 * Decodes in one pass so that the output is never decoded again: `&amp;quot;` becomes `&quot;`, not `"`.
 */
export function decodeHtmlEntities(text) {
  return text.replace(/&(?:amp|quot|#x27);/g, (entity) => entities[entity]);
}
