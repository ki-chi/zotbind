import { readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const addonRoot = path.join(projectRoot, "addon");
const manifest = JSON.parse(await readFile(path.join(addonRoot, "manifest.json"), "utf8"));
let errors = [];

if (manifest.manifest_version !== 2) errors.push("manifest_version must be 2");
let zotero = manifest.applications && manifest.applications.zotero;
if (!zotero || zotero.strict_min_version !== "9.0") errors.push("strict_min_version must be 9.0");
if (!zotero || !/^9\.0(?:\.\*)?$/.test(zotero.strict_max_version)) errors.push("strict_max_version must match the tested Zotero 9 range");
if (!zotero || !/^https:\/\//.test(zotero.update_url)) errors.push("update_url must use HTTPS");

async function walk(directory) {
  let output = [];
  for (let entry of await readdir(directory)) {
    let absolute = path.join(directory, entry);
    if ((await stat(absolute)).isDirectory()) output.push(...await walk(absolute));
    else output.push(absolute);
  }
  return output;
}

let files = await walk(addonRoot);
for (let file of files.filter(file => file.endsWith(".js"))) {
  let check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) errors.push(check.stderr.trim());
}
for (let required of [
  "bootstrap.js",
  "prefs.js",
  "preferences.xhtml",
  "preferences.js",
  "preferences.css",
  "locale/en-US/zotbind.ftl",
  "locale/ja-JP/zotbind.ftl",
  "icons/zotbind.svg"
]) {
  if (!files.includes(path.join(addonRoot, required))) errors.push("Missing package file: " + required);
}
let menuSource = await readFile(path.join(addonRoot, "content/ui.js"), "utf8");
let menuL10nIDs = [...menuSource.matchAll(/l10nID:\s*"([^"]+)"/g)].map(match => match[1]);
for (let locale of ["en-US", "ja-JP"]) {
  let ftl = await readFile(path.join(addonRoot, `locale/${locale}/zotbind.ftl`), "utf8");
  for (let id of menuL10nIDs) {
    let escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!(new RegExp(`^${escaped}\\s*=\\s*\\n\\s+\\.label\\s*=`, "m")).test(ftl)) {
      errors.push(`Menu localization ${id} in ${locale} must define a .label attribute`);
    }
  }
}
for (let file of files) {
  if (!/\.(js|json|xhtml|css|ftl|svg)$/.test(file)) continue;
  let contents = await readFile(file, "utf8");
  if (/\/Users\/|[A-Z]:\\Users\\/.test(contents)) errors.push("Local absolute path found in " + path.relative(projectRoot, file));
  if (/BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/.test(contents)) errors.push("Private key material found in " + path.relative(projectRoot, file));
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Validated ${files.length} packaged files for Zotero ${zotero.strict_min_version}–${zotero.strict_max_version}.`);
