/* Safe filesystem adapter. Only manifest-owned symbolic links are mutated. */
var ZotBindFilesystem = {
  manifestPath(destinationPath) {
    return PathUtils.join(destinationPath, ZotBindCore.MANIFEST_NAME);
  },

  journalPath(destinationPath) {
    return PathUtils.join(destinationPath, ZotBindCore.JOURNAL_NAME);
  },

  linkPath(destinationPath, filename) {
    return PathUtils.join(destinationPath, filename);
  },

  pathKey(path) {
    let value = String(path || "");
    try {
      let file = Zotero.File.pathToFile(value);
      file.normalize();
      value = file.path;
    }
    catch (_) {}
    return Services.appinfo.OS === "WINNT" ? value.toLocaleLowerCase("en-US") : value;
  },

  pathsEqual(left, right) {
    return this.pathKey(left) === this.pathKey(right);
  },

  async assertDestination(destinationPath) {
    try {
      let stat = await IOUtils.stat(destinationPath);
      if (stat.type !== "directory") {
        throw ZotBindCore.codedError("DESTINATION_UNAVAILABLE", "Destination is not a directory: " + destinationPath);
      }
      return true;
    }
    catch (error) {
      if (error.code) throw error;
      let code = String(error).toLowerCase().includes("access")
        ? "DESTINATION_PERMISSION_DENIED"
        : "DESTINATION_UNAVAILABLE";
      throw ZotBindCore.codedError(code, "Destination is unavailable: " + destinationPath, String(error));
    }
  },

  async sourceIsUsable(path) {
    try {
      let stat = await IOUtils.stat(path);
      return stat.type === "regular";
    }
    catch (_) {
      return false;
    }
  },

  async classify(path) {
    let file = Zotero.File.pathToFile(path);
    let isSymlink = false;
    try { isSymlink = file.isSymlink(); }
    catch (_) {}
    if (isSymlink) {
      let target = null;
      try { target = file.target; }
      catch (_) {}
      return { type: "symlink", target };
    }
    try {
      if (!file.exists()) return { type: "none", target: null };
      if (file.isFile()) return { type: "file", target: null };
      if (file.isDirectory()) return { type: "directory", target: null };
    }
    catch (error) {
      throw ZotBindCore.codedError("DESTINATION_PERMISSION_DENIED", "Cannot inspect path: " + path, String(error));
    }
    return { type: "other", target: null };
  },

  async readManifest(destinationPath, allowMissing = true) {
    let path = this.manifestPath(destinationPath);
    try {
      let value = await IOUtils.readJSON(path);
      return ZotBindCore.migrateManifest(value);
    }
    catch (error) {
      if (allowMissing && !(await IOUtils.exists(path))) return null;
      if (error.code === "MANIFEST_SCHEMA_UNSUPPORTED") throw error;
      throw ZotBindCore.codedError("MANIFEST_CORRUPT", "Cannot safely read " + ZotBindCore.MANIFEST_NAME, String(error));
    }
  },

  async writeManifest(destinationPath, manifest) {
    ZotBindCore.validateManifest(manifest);
    try {
      await IOUtils.writeJSON(this.manifestPath(destinationPath), manifest);
    }
    catch (error) {
      throw ZotBindCore.codedError("DESTINATION_PERMISSION_DENIED", "Cannot write the ZotBind manifest in " + destinationPath, String(error));
    }
  },

  async readJournal(destinationPath) {
    let path = this.journalPath(destinationPath);
    try {
      return await IOUtils.readJSON(path);
    }
    catch (error) {
      if (!(await IOUtils.exists(path))) return null;
      throw ZotBindCore.codedError("TRANSACTION_CORRUPT", "Interrupted transaction journal is corrupt", String(error));
    }
  },

  async writeJournal(destinationPath, journal) {
    try {
      await IOUtils.writeJSON(this.journalPath(destinationPath), journal);
    }
    catch (error) {
      throw ZotBindCore.codedError("DESTINATION_PERMISSION_DENIED", "Cannot write the ZotBind transaction journal in " + destinationPath, String(error));
    }
  },

  async removeJournal(destinationPath) {
    try {
      await IOUtils.remove(this.journalPath(destinationPath), { ignoreAbsent: true });
    }
    catch (error) {
      throw ZotBindCore.codedError("DESTINATION_PERMISSION_DENIED", "Cannot clear the ZotBind transaction journal in " + destinationPath, String(error));
    }
  },

  async rebuildCorruptManifest(destinationPath) {
    await this.assertDestination(destinationPath);
    let journal = await this.readJournal(destinationPath);
    if (journal) {
      throw ZotBindCore.codedError("TRANSACTION_RECOVERY_REQUIRED", "Resolve the interrupted transaction before rebuilding the manifest.");
    }
    let manifestPath = this.manifestPath(destinationPath);
    if (!(await IOUtils.exists(manifestPath))) {
      await this.writeManifest(destinationPath, ZotBindCore.emptyManifest());
      return null;
    }
    let backupName = ".zotero-paper-links.corrupt-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + ZotBindCore.uuid() + ".json";
    let backupPath = PathUtils.join(destinationPath, backupName);
    await IOUtils.move(manifestPath, backupPath, { noOverwrite: true });
    try {
      await this.writeManifest(destinationPath, ZotBindCore.emptyManifest());
    }
    catch (error) {
      try { await IOUtils.move(backupPath, manifestPath, { noOverwrite: true }); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    }
    return backupPath;
  },

  async createSymlink(sourcePath, linkPath) {
    if (!(await this.sourceIsUsable(sourcePath))) {
      throw ZotBindCore.codedError("PDF_NOT_LOCAL", "PDF file is not available locally: " + sourcePath);
    }
    let result;
    if (Services.appinfo.OS === "WINNT") result = this._createWindowsSymlink(sourcePath, linkPath);
    else result = Zotero.File.createSymlink(sourcePath, linkPath);
    if (!result) {
      throw ZotBindCore.codedError(
        "SYMLINK_PERMISSION_DENIED",
        "Could not create a symbolic link. On Windows, enable Developer Mode or grant symbolic-link permission."
      );
    }
    let actual = await this.classify(linkPath);
    if (actual.type !== "symlink" || !actual.target || !this.pathsEqual(actual.target, sourcePath) || !(await this.sourceIsUsable(linkPath))) {
      if (actual.type === "symlink" && actual.target && this.pathsEqual(actual.target, sourcePath)) {
        await IOUtils.remove(linkPath, { ignoreAbsent: true });
      }
      throw ZotBindCore.codedError("MANAGED_LINK_TARGET_INVALID", "Created link could not be verified: " + linkPath);
    }
  },

  _createWindowsSymlink(sourcePath, linkPath) {
    const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    let kernel32;
    try {
      kernel32 = ctypes.open("kernel32.dll");
      let createSymbolicLink = kernel32.declare(
        "CreateSymbolicLinkW",
        ctypes.winapi_abi,
        ctypes.bool,
        ctypes.jschar.ptr,
        ctypes.jschar.ptr,
        ctypes.uint32_t
      );
      let linkBuffer = ctypes.jschar.array()(linkPath);
      let targetBuffer = ctypes.jschar.array()(sourcePath);
      // 0x2 requests unprivileged creation when Windows Developer Mode allows it.
      if (createSymbolicLink(linkBuffer, targetBuffer, 0x2)) return true;
      return Boolean(createSymbolicLink(linkBuffer, targetBuffer, 0));
    }
    catch (error) {
      Zotero.logError(error);
      return false;
    }
    finally {
      if (kernel32) kernel32.close();
    }
  },

  async removeSymlink(path, expectedTarget, allowDifferentTarget = false) {
    let actual = await this.classify(path);
    if (actual.type === "none") return;
    if (actual.type !== "symlink") {
      throw ZotBindCore.codedError("UNMANAGED_PATH_CONFLICT", "Refusing to remove a non-symlink: " + path);
    }
    if (!allowDifferentTarget && (!actual.target || !this.pathsEqual(actual.target, expectedTarget))) {
      throw ZotBindCore.codedError("MANAGED_LINK_TARGET_INVALID", "Refusing to remove a link whose target differs from the manifest: " + path);
    }
    await IOUtils.remove(path);
  },

  async replaceManagedSymlink(path, oldTarget, newTarget) {
    let actual = await this.classify(path);
    if (actual.type === "none") {
      await this.createSymlink(newTarget, path);
      return;
    }
    if (actual.type !== "symlink") {
      throw ZotBindCore.codedError("UNMANAGED_PATH_CONFLICT", "Refusing to replace a non-symlink: " + path);
    }
    await this.removeSymlink(path, oldTarget, true);
    try {
      await this.createSymlink(newTarget, path);
    }
    catch (error) {
      try {
        if (await this.sourceIsUsable(oldTarget)) await this.createSymlink(oldTarget, path);
      }
      catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    }
  }
};
