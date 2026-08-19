import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the Zotero 9 preference pane initializes from its dispatched load event", async () => {
  let markup = await readFile(new URL("../addon/preferences.xhtml", import.meta.url), "utf8");
  assert.match(markup, /<vbox\b[^>]*\bonload="ZotBindPreferences\.init\(\)"/s);
  assert.doesNotMatch(markup, /\bonshowing=/);
  assert.match(markup, /xmlns="http:\/\/www\.mozilla\.org\/keymaster\/gatekeeper\/there\.is\.only\.xul"/);
  assert.match(markup, /xmlns:html="http:\/\/www\.w3\.org\/1999\/xhtml"/);
});

test("dynamically rendered preference table controls use the HTML namespace", async () => {
  let source = await readFile(new URL("../addon/preferences.js", import.meta.url), "utf8");
  assert.match(source, /document\.createElementNS\(ZOTBIND_HTML_NS, "tr"\)/);
  assert.match(source, /document\.createElementNS\(ZOTBIND_HTML_NS, "td"\)/);
  assert.match(source, /document\.createElementNS\(ZOTBIND_HTML_NS, "button"\)/);
});
