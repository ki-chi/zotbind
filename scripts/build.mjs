import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const addonRoot = path.join(projectRoot, "addon");
const distRoot = path.join(projectRoot, "dist");
const manifest = JSON.parse(await readFile(path.join(addonRoot, "manifest.json"), "utf8"));
const version = manifest.version;
const addonID = manifest.applications.zotero.id;
const xpiName = `zotbind-${version}.xpi`;
const xpiPath = path.join(distRoot, xpiName);

async function filesBelow(directory, prefix = "") {
  let output = [];
  for (let entry of await readdir(directory, { withFileTypes: true })) {
    let relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(path.join(directory, entry.name), relative));
    else output.push(relative);
  }
  return output.sort();
}

await mkdir(distRoot, { recursive: true });
await rm(xpiPath, { force: true });
let files = await filesBelow(addonRoot);
let result = spawnSync("zip", ["-X", "-q", xpiPath, ...files], {
  cwd: addonRoot,
  encoding: "utf8"
});
if (result.status !== 0) throw new Error(result.stderr || "zip failed");

let bytes = await readFile(xpiPath);
let hash = createHash("sha256").update(bytes).digest("hex");
let updateLink = `https://github.com/kiichi/zotbind/releases/download/v${version}/${xpiName}`;
let updates = {
  addons: {
    [addonID]: {
      updates: [{
        version,
        update_link: updateLink,
        update_hash: `sha256:${hash}`,
        applications: {
          zotero: {
            strict_min_version: manifest.applications.zotero.strict_min_version,
            strict_max_version: manifest.applications.zotero.strict_max_version
          }
        }
      }]
    }
  }
};
await writeFile(path.join(projectRoot, "updates.json"), JSON.stringify(updates, null, 2) + "\n");
await writeFile(path.join(distRoot, `${xpiName}.sha256`), `${hash}  ${xpiName}\n`);
console.log(`${xpiPath}\nsha256:${hash}`);
