import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeHtmlEntities } from "./decode-html-entities.mjs";

test("decodes each supported entity", () => {
  assert.equal(decodeHtmlEntities("a &amp; b &quot;c&quot; d&#x27;s"), `a & b "c" d's`);
});

test("does not decode the output of a decoded entity again", () => {
  assert.equal(decodeHtmlEntities("Use &amp;quot; in HTML"), "Use &quot; in HTML");
  assert.notEqual(decodeHtmlEntities("Use &amp;quot; in HTML"), decodeHtmlEntities("Use &quot; in HTML"));
});
