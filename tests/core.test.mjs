import test from "node:test";
import assert from "node:assert/strict";

await import("../addon/content/core.js");
const core = globalThis.ZotBindCore;

function owner(bindingID, libraryID = 1, collectionKey = "COLL") {
  return { bindingID, libraryID, collectionKey };
}

function record(overrides = {}) {
  return {
    filename: "key.pdf",
    target: "/source/key.pdf",
    itemLibraryID: 1,
    itemKey: "ITEM0001",
    attachmentKey: "ATTACH01",
    citationKey: "key",
    bindings: [owner("binding-a")],
    ...overrides
  };
}

test("filename resolution prefers citation key and falls back to item key", () => {
  assert.equal(core.resolveFilename("kyle1985", "AB12CD34"), "kyle1985.pdf");
  assert.equal(core.resolveFilename("", "AB12CD34"), "AB12CD34.pdf");
  assert.equal(core.resolveFilename(null, "AB12CD34"), "AB12CD34.pdf");
});

test("Zotero 9 FilePicker path strings are preserved", () => {
  assert.equal(core.filePickerPath("/project/papers"), "/project/papers");
  assert.equal(core.filePickerPath({ path: "/legacy/papers" }), "/legacy/papers");
  assert.equal(core.filePickerPath(null), null);
});

test("filename sanitization is path-safe and portable to Windows", () => {
  assert.equal(core.resolveFilename("../bad\\name:paper?", "ITEM"), ".._bad_name_paper_.pdf");
  assert.equal(core.resolveFilename("CON", "ITEM"), "_CON.pdf");
  assert.equal(core.resolveFilename("paper. ", "ITEM"), "paper.pdf");
  assert.equal(core.resolveFilename("e\u0301tude", "ITEM"), "étude.pdf");
  let long = core.resolveFilename("論".repeat(300), "ITEM");
  assert.ok(core.utf8Length(long) <= core.MAX_COMPONENT_BYTES);
  assert.ok(long.endsWith(".pdf"));
});

test("same item in two bindings aggregates ownership", () => {
  let first = record();
  let second = record({ bindings: [owner("binding-b", 1, "COLL2")] });
  let result = core.aggregateDesired([first, second]);
  assert.equal(result.collisions.length, 0);
  assert.deepEqual(result.desired.get("key.pdf").bindings.map(value => value.bindingID), ["binding-a", "binding-b"]);
});

test("distinct item identities resolving to one filename are all collisions", () => {
  let result = core.aggregateDesired([
    record(),
    record({ itemKey: "ITEM0002", attachmentKey: "ATTACH02", bindings: [owner("binding-b")] })
  ]);
  assert.equal(result.desired.size, 0);
  assert.equal(result.collisions.length, 1);
  assert.deepEqual(result.collisions[0].identities.sort(), ["1:ITEM0001", "1:ITEM0002"]);
});

test("filename collisions are portable across case-insensitive filesystems", () => {
  let result = core.aggregateDesired([
    record({ filename: "Key.pdf" }),
    record({ filename: "key.pdf", itemKey: "ITEM0002", attachmentKey: "ATTACH02", bindings: [owner("binding-b")] })
  ]);
  assert.equal(result.desired.size, 0);
  assert.equal(result.collisions.length, 1);
});

test("manifest validation rejects untrusted and malformed state", () => {
  assert.throws(() => core.validateManifest({}), error => error.code === "MANIFEST_CORRUPT");
  let manifest = core.emptyManifest("destination");
  manifest.links["bad/name.pdf"] = record();
  assert.throws(() => core.validateManifest(manifest), error => error.code === "MANIFEST_CORRUPT");
  let relative = core.emptyManifest("destination");
  relative.links["key.pdf"] = record({ target: "relative/source.pdf" });
  assert.throws(() => core.validateManifest(relative), error => error.code === "MANIFEST_CORRUPT");
});

test("development manifest version 0 migrates without changing link ownership", () => {
  let legacy = core.emptyManifest("destination");
  legacy.schemaVersion = 0;
  legacy.links["key.pdf"] = record();
  let migrated = core.migrateManifest(legacy);
  assert.equal(migrated.schemaVersion, 1);
  assert.deepEqual(migrated.links["key.pdf"].bindings, legacy.links["key.pdf"].bindings);
  let future = { ...legacy, schemaVersion: 99 };
  assert.throws(() => core.migrateManifest(future), error => error.code === "MANIFEST_SCHEMA_UNSUPPORTED");
});

test("ownership planning removes stale active ownership but preserves paused ownership", () => {
  let manifest = core.emptyManifest("destination");
  manifest.links["key.pdf"] = record({ bindings: [owner("binding-a"), owner("binding-paused")] });
  let next = core.buildOwnershipState(manifest, ["binding-a"], [], []);
  assert.deepEqual(next.links["key.pdf"].bindings.map(value => value.bindingID), ["binding-paused"]);
});

test("protected ownership preserves last-known filename after transient read failure", () => {
  let manifest = core.emptyManifest("destination");
  manifest.links["old.pdf"] = record({ filename: "old.pdf" });
  let key = core.ownershipKey("binding-a", 1, "ITEM0001");
  let next = core.buildOwnershipState(manifest, ["binding-a"], [key], []);
  assert.ok(next.links["old.pdf"]);
});

test("successful rename adds new ownership before old record becomes stale", () => {
  let manifest = core.emptyManifest("destination");
  manifest.links["old.pdf"] = record({ filename: "old.pdf" });
  let desired = record({ filename: "new.pdf", citationKey: "new" });
  let next = core.buildOwnershipState(manifest, ["binding-a"], [], [desired]);
  assert.equal(next.links["old.pdf"].bindings.length, 0);
  assert.equal(next.links["new.pdf"].bindings.length, 1);
});

test("candidate assessment protects regular files and unmanaged symlinks", () => {
  let desired = record();
  assert.equal(core.assessCandidate(desired, null, { type: "file" }, []).code, "UNMANAGED_PATH_CONFLICT");
  assert.equal(core.assessCandidate(desired, null, { type: "symlink" }, []).code, "UNMANAGED_PATH_CONFLICT");
  assert.equal(core.assessCandidate(desired, null, { type: "none" }, []), null);
});

test("paused ownership prevents mutation of a frozen link", () => {
  let old = record({ bindings: [owner("binding-paused")] });
  let desired = record({ target: "/source/new.pdf", bindings: [owner("binding-a")] });
  assert.equal(core.assessCandidate(desired, old, { type: "symlink" }, ["binding-paused"]).code, "FROZEN_LINK_CONFLICT");
});
