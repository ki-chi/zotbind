import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("every MenuManager localization defines Zotero's required label attribute", async () => {
  let source = await readFile(new URL("../addon/content/ui.js", import.meta.url), "utf8");
  let ids = [...source.matchAll(/l10nID:\s*"([^"]+)"/g)].map(match => match[1]);
  assert.ok(ids.length > 0);
  for (let locale of ["en-US", "ja-JP"]) {
    let ftl = await readFile(new URL(`../addon/locale/${locale}/zotbind.ftl`, import.meta.url), "utf8");
    for (let id of ids) {
      let escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(ftl, new RegExp(`^${escaped}\\s*=\\s*\\n\\s+\\.label\\s*=`, "m"), `${locale}: ${id}`);
    }
  }
});
