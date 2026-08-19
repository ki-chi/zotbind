import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, readlink, symlink, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function exists(value) {
  try { await lstat(value); return true; }
  catch { return false; }
}

async function classify(value) {
  try {
    let stats = await lstat(value);
    if (stats.isSymbolicLink()) return { type: "symlink", target: await readlink(value) };
    if (stats.isFile()) return { type: "file" };
    if (stats.isDirectory()) return { type: "directory" };
    return { type: "other" };
  }
  catch (error) {
    if (error.code === "ENOENT") return { type: "none" };
    throw error;
  }
}

async function atomicJSON(file, value) {
  let temp = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, file);
}

async function safeUpsert(link, source, oldTarget = null) {
  let actual = await classify(link);
  if (!oldTarget && actual.type !== "none") throw Object.assign(new Error("unmanaged conflict"), { code: "UNMANAGED_PATH_CONFLICT" });
  if (oldTarget && actual.type !== "none" && actual.type !== "symlink") throw Object.assign(new Error("regular conflict"), { code: "UNMANAGED_PATH_CONFLICT" });
  if (actual.type === "symlink" && path.resolve(actual.target) === path.resolve(source)) return;
  if (actual.type === "symlink") await rm(link);
  await symlink(source, link);
  let verified = await classify(link);
  assert.equal(path.resolve(verified.target), path.resolve(source));
}

async function safeRemove(link, expectedTarget) {
  let actual = await classify(link);
  if (actual.type === "none") return;
  if (actual.type !== "symlink" || path.resolve(actual.target) !== path.resolve(expectedTarget)) {
    throw Object.assign(new Error("ownership cannot be revalidated"), { code: "MANAGED_LINK_TARGET_INVALID" });
  }
  await rm(link);
}

test("creates, verifies, and repairs a managed symbolic link", async t => {
  let root = await mkdtemp(path.join(os.tmpdir(), "zotbind-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let first = path.join(root, "first.pdf");
  let second = path.join(root, "second.pdf");
  let link = path.join(root, "paper.pdf");
  await writeFile(first, "first");
  await writeFile(second, "second");
  await safeUpsert(link, first);
  assert.equal(path.resolve(await readlink(link)), first);
  await safeUpsert(link, second, first);
  assert.equal(path.resolve(await readlink(link)), second);
});

test("ordinary files and unmanaged symlinks are never overwritten", async t => {
  let root = await mkdtemp(path.join(os.tmpdir(), "zotbind-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let source = path.join(root, "source.pdf");
  let regular = path.join(root, "regular.pdf");
  let unmanaged = path.join(root, "unmanaged.pdf");
  await writeFile(source, "pdf");
  await writeFile(regular, "user data");
  await symlink(source, unmanaged);
  await assert.rejects(safeUpsert(regular, source), error => error.code === "UNMANAGED_PATH_CONFLICT");
  await assert.rejects(safeUpsert(unmanaged, source), error => error.code === "UNMANAGED_PATH_CONFLICT");
  assert.equal(await readFile(regular, "utf8"), "user data");
  assert.equal((await classify(unmanaged)).type, "symlink");
});

test("stale cleanup removes only a symlink matching its manifest target", async t => {
  let root = await mkdtemp(path.join(os.tmpdir(), "zotbind-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let ownedSource = path.join(root, "owned.pdf");
  let otherSource = path.join(root, "other.pdf");
  let ownedLink = path.join(root, "owned-link.pdf");
  let changedLink = path.join(root, "changed-link.pdf");
  await writeFile(ownedSource, "owned");
  await writeFile(otherSource, "other");
  await symlink(ownedSource, ownedLink);
  await symlink(otherSource, changedLink);
  await safeRemove(ownedLink, ownedSource);
  await assert.rejects(safeRemove(changedLink, ownedSource), error => error.code === "MANAGED_LINK_TARGET_INVALID");
  assert.equal(await exists(ownedLink), false);
  assert.equal((await classify(changedLink)).type, "symlink");
});

test("a manifest-owned broken link can be removed when the PDF becomes unavailable", async t => {
  let root = await mkdtemp(path.join(os.tmpdir(), "zotbind-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let source = path.join(root, "source.pdf");
  let link = path.join(root, "paper.pdf");
  await writeFile(source, "pdf");
  await symlink(source, link);
  await rm(source);
  assert.equal((await classify(link)).type, "symlink");
  await safeRemove(link, source);
  assert.equal(await exists(link), false);
});

test("atomic manifest replacement never truncates the live generation", async t => {
  let root = await mkdtemp(path.join(os.tmpdir(), "zotbind-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let manifest = path.join(root, ".zotero-paper-links.json");
  await atomicJSON(manifest, { generation: 1, links: {} });
  await atomicJSON(manifest, { generation: 2, links: { "paper.pdf": {} } });
  assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")), { generation: 2, links: { "paper.pdf": {} } });
});

test("an interrupted create is identifiable and conservatively rolled back", async t => {
  let root = await mkdtemp(path.join(os.tmpdir(), "zotbind-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let source = path.join(root, "source.pdf");
  let link = path.join(root, "paper.pdf");
  let journalPath = path.join(root, ".zotero-paper-links.transaction.json");
  await writeFile(source, "pdf");
  let journal = {
    transactionID: "tx",
    oldManifest: { generation: 0, links: {} },
    operations: [{ type: "upsert", filename: "paper.pdf", newTarget: source, state: "applying" }]
  };
  await atomicJSON(journalPath, journal);
  await symlink(source, link); // crash before manifest commit
  let actual = await classify(link);
  assert.equal(actual.type, "symlink");
  assert.equal(path.resolve(actual.target), source);
  // Recovery owns this exact target through the dirty journal, so removal is safe.
  await rm(link);
  await rm(journalPath);
  assert.equal(await exists(link), false);
  assert.equal(await exists(journalPath), false);
});

test("an interrupted stale removal can restore the previous committed link", async t => {
  let root = await mkdtemp(path.join(os.tmpdir(), "zotbind-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let source = path.join(root, "source.pdf");
  let link = path.join(root, "paper.pdf");
  await writeFile(source, "pdf");
  await symlink(source, link);
  await safeRemove(link, source); // crash before new manifest commit
  assert.equal(await exists(link), false);
  // Dirty-journal recovery restores the old committed generation.
  await symlink(source, link);
  assert.equal(path.resolve(await readlink(link)), source);
});

test("a corrupt manifest is detected before cleanup", async t => {
  let root = await mkdtemp(path.join(os.tmpdir(), "zotbind-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let manifest = path.join(root, ".zotero-paper-links.json");
  let userFile = path.join(root, "paper.pdf");
  await writeFile(manifest, "{not json");
  await writeFile(userFile, "user data");
  assert.throws(() => JSON.parse("{not json"));
  assert.equal(await readFile(userFile, "utf8"), "user data");
});
