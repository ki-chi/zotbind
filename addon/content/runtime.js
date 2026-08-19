/* Lifecycle coordinator and public API used by Preferences. */
var ZotBindRuntime = {
  id: null,
  rootURI: null,
  notifierID: null,
  started: false,

  async start({ id, rootURI }) {
    if (this.started) return;
    this.started = true;
    this.id = id;
    this.rootURI = rootURI;
    ZotBindConfig.init();
    ZotBindSync.init();
    await ZotBindUI.init({ id, rootURI });
    this.notifierID = ZotBindZoteroAdapter.registerNotifier((event, type, ids, extraData) => this.onNotify(event, type, ids, extraData));
    Zotero.ZotBind = this.publicAPI();
    await ZotBindSync.startupCheck();
    Zotero.debug("ZotBind 0.1.3 startup complete");
    setTimeout(() => this.resumePendingPrompts(), 500);
  },

  publicAPI() {
    return {
      listBindings: () => ZotBindConfig.list(),
      getStatus: bindingID => ZotBindConfig.getStatus(bindingID),
      listCollections: () => ZotBindZoteroAdapter.listCollections(),
      collectionLabel: binding => ZotBindZoteroAdapter.collectionLabel(binding),
      libraryLabel: libraryID => ZotBindZoteroAdapter.libraryLabel(libraryID),
      chooseDirectory: (window, initialPath) => ZotBindUI.chooseDirectory(window, initialPath),
      addOrUpdateBinding: input => this.addOrUpdateBinding(input),
      syncNow: bindingID => ZotBindSync.requestBinding(bindingID, "manual", { immediate: true }),
      toggleBinding: bindingID => this.toggleBinding(bindingID),
      removeBinding: (bindingID, window) => ZotBindUI.promptRemoveBinding(bindingID, window),
      removeAllBindings: window => this.removeAllBindings(window),
      changeDestination: (bindingID, path, window) => this.changeDestination(bindingID, path, window),
      retryDestinationChange: (bindingID, window) => this.retryDestinationChange(bindingID, window),
      cancelDestinationChange: (bindingID, window) => this.cancelDestinationChange(bindingID, window),
      cleanupOldDestination: (bindingID, window) => this.cleanupOldDestination(bindingID, window),
      openDestination: bindingID => this.openDestination(bindingID),
      showStatus: (bindingID, window) => ZotBindUI.showStatus(bindingID, window),
      rebuildManifest: (bindingID, window) => this.rebuildManifest(bindingID, window),
      resolvePendingCleanup: (bindingID, window) => ZotBindUI.promptPendingCleanup(bindingID, window)
    };
  },

  async onMainWindowLoad(window) {
    if (this.started) await ZotBindUI.onMainWindowLoad(window);
  },

  onMainWindowUnload(window) {
    ZotBindUI.onMainWindowUnload(window);
  },

  async addOrUpdateBinding(input) {
    await ZotBindFilesystem.assertDestination(input.destinationPath);
    let existing = ZotBindConfig.find(input.libraryID, input.collectionKey);
    if (existing && ZotBindFilesystem.pathKey(existing.destinationPath) !== ZotBindFilesystem.pathKey(input.destinationPath)) {
      return this.changeDestination(existing.bindingID, input.destinationPath, Zotero.getMainWindow());
    }
    let binding = ZotBindConfig.upsert({
      ...(existing || {}),
      ...input,
      enabled: true,
      lifecycleState: "active",
      pendingDestinationPath: null
    });
    return ZotBindSync.requestBinding(binding.bindingID, "binding-created", { immediate: true });
  },

  async toggleBinding(bindingID) {
    let binding = ZotBindConfig.get(bindingID);
    if (!binding || binding.lifecycleState === "pendingCleanup") return;
    if (binding.enabled !== false) {
      ZotBindConfig.upsert({ ...binding, enabled: false, lifecycleState: "paused" });
      ZotBindConfig.setStatus(bindingID, {
        state: "Paused",
        enabled: false,
        lifecycleState: "paused",
        syncing: false,
        message: "Synchronization is paused; existing links are frozen."
      });
      return;
    }
    ZotBindConfig.upsert({ ...binding, enabled: true, lifecycleState: "active" });
    return ZotBindSync.requestBinding(bindingID, "binding-resumed", { immediate: true });
  },

  async changeDestination(bindingID, newPath, window) {
    let binding = ZotBindConfig.get(bindingID);
    if (!binding) throw new Error("Binding not found");
    if (ZotBindFilesystem.pathKey(binding.destinationPath) === ZotBindFilesystem.pathKey(newPath)) {
      return ZotBindSync.requestBinding(bindingID, "manual", { immediate: true });
    }
    await ZotBindFilesystem.assertDestination(newPath);
    let oldPath = binding.destinationPath;
    ZotBindConfig.upsert({
      ...binding,
      lifecycleState: "pendingDestinationChange",
      pendingDestinationPath: newPath,
      previousDestinationPath: oldPath
    });
    let staged = { ...binding, destinationPath: newPath, enabled: true, lifecycleState: "active" };
    let otherBindings = ZotBindConfig.list().filter(value =>
      value.bindingID !== bindingID && ZotBindFilesystem.pathKey(value.destinationPath) === ZotBindFilesystem.pathKey(newPath)
    );
    let result;
    try {
      result = await ZotBindSync.reconcileDestination(newPath, { bindings: [...otherBindings, staged], reasons: ["destination-change"] });
    }
    catch (error) {
      ZotBindConfig.setStatus(bindingID, {
        state: "Action required",
        lifecycleState: "pendingDestinationChange",
        message: "The new destination could not be synchronized; the old destination is unchanged.",
        errors: [ZotBindCore.makeIssue(error.code || "DESTINATION_CHANGE_FAILED", error.message || String(error))]
      });
      throw error;
    }
    if (result.errors.length) {
      ZotBindConfig.setStatus(bindingID, {
        state: "Action required",
        lifecycleState: "pendingDestinationChange",
        message: "Fix errors in the new destination, then retry or choose another directory.",
        errors: result.errors
      });
      return result;
    }
    let committed = ZotBindConfig.upsert({
      ...binding,
      destinationPath: newPath,
      enabled: true,
      lifecycleState: "active",
      pendingDestinationPath: null,
      previousDestinationPath: oldPath
    });
    try {
      await ZotBindUI.promptOldDestinationCleanup(binding, oldPath, window);
      committed = ZotBindConfig.upsert({ ...committed, previousDestinationPath: null });
    }
    catch (error) {
      ZotBindConfig.setStatus(bindingID, {
        state: "Warning",
        message: "The new destination is active, but old-destination cleanup is incomplete.",
        warnings: [ZotBindCore.makeIssue(error.code || "OLD_DESTINATION_CLEANUP_FAILED", error.message || String(error))]
      });
    }
    return result;
  },

  async retryDestinationChange(bindingID, window) {
    let binding = ZotBindConfig.get(bindingID);
    if (!binding || binding.lifecycleState !== "pendingDestinationChange" || !binding.pendingDestinationPath) return;
    return this.changeDestination(bindingID, binding.pendingDestinationPath, window);
  },

  async cancelDestinationChange(bindingID, window) {
    let binding = ZotBindConfig.get(bindingID);
    if (!binding || binding.lifecycleState !== "pendingDestinationChange" || !binding.pendingDestinationPath) return false;
    let choice = ZotBindUI._threeButton(
      window || Zotero.getMainWindow(),
      "Cancel destination change",
      "The old directory is still active. What should happen to links already created in the incomplete new directory?\n\n" + binding.pendingDestinationPath,
      "Remove managed links",
      "Keep links",
      "Keep trying"
    );
    if (choice === 2) return false;
    await ZotBindSync.detachAtDestination(binding, binding.pendingDestinationPath, choice === 0);
    ZotBindConfig.upsert({
      ...binding,
      enabled: true,
      lifecycleState: "active",
      pendingDestinationPath: null,
      previousDestinationPath: null
    });
    await ZotBindSync.requestBinding(bindingID, "destination-change-cancelled", { immediate: true });
    return true;
  },

  async cleanupOldDestination(bindingID, window) {
    let binding = ZotBindConfig.get(bindingID);
    if (!binding || !binding.previousDestinationPath) return;
    await ZotBindUI.promptOldDestinationCleanup(binding, binding.previousDestinationPath, window);
    ZotBindConfig.upsert({ ...binding, previousDestinationPath: null });
    await ZotBindSync.requestBinding(bindingID, "old-destination-cleaned", { immediate: true });
  },

  async openDestination(bindingID) {
    let binding = ZotBindConfig.get(bindingID);
    if (!binding) return;
    await Zotero.File.reveal(binding.destinationPath);
  },

  async rebuildManifest(bindingID, window) {
    let binding = ZotBindConfig.get(bindingID);
    if (!binding) return;
    let confirmed = Services.prompt.confirm(
      window || Zotero.getMainWindow(),
      "Rebuild ZotBind manifest",
      "The corrupt manifest will be preserved as a timestamped backup. Existing files and symlinks will not be adopted, overwritten, or deleted. Conflicting paths may need manual review. Continue?"
    );
    if (!confirmed) return;
    let backup = await ZotBindFilesystem.rebuildCorruptManifest(binding.destinationPath);
    let result = await ZotBindSync.requestBinding(bindingID, "manifest-rebuild", { immediate: true });
    Services.prompt.alert(
      window || Zotero.getMainWindow(),
      "ZotBind",
      backup ? "The old manifest was preserved at:\n" + backup : "A new manifest was created."
    );
    return result;
  },

  async removeAllBindings(window) {
    let byDestination = new Map();
    for (let binding of ZotBindConfig.list()) {
      let key = ZotBindFilesystem.pathKey(binding.destinationPath);
      if (!byDestination.has(key)) byDestination.set(key, { path: binding.destinationPath, bindings: [] });
      byDestination.get(key).bindings.push(binding);
    }
    for (let group of byDestination.values()) {
      let choice = ZotBindUI._threeButton(
        window || Zotero.getMainWindow(),
        "Remove all ZotBind bindings",
        "Choose cleanup behavior for:\n" + group.path,
        "Remove managed links",
        "Keep links",
        "Cancel all"
      );
      if (choice === 2) return false;
      for (let binding of group.bindings) {
        await ZotBindSync.detachAtDestination(binding, group.path, choice === 0);
        ZotBindConfig.remove(binding.bindingID);
      }
    }
    return true;
  },

  async onNotify(event, type, ids, extraData) {
    if (!this.started || ZotBindSync.stopping) return;
    if (type === "collection" && event === "delete") {
      for (let id of ids) {
        let identity = ZotBindZoteroAdapter.deletedObjectIdentity(type, id, extraData);
        if (!identity) continue;
        let changed = ZotBindConfig.markCollectionDeleted(identity.libraryID, identity.collectionKey);
        for (let bindingID of changed) {
          setTimeout(() => ZotBindUI.promptPendingCleanup(bindingID, Zotero.getMainWindow()), 0);
        }
      }
      return;
    }

    let bindingIDs = new Set();
    if (type === "collection-item") {
      for (let compoundID of ids) {
        let collectionID = Number(String(compoundID).split("-")[0]);
        let collection = Zotero.Collections.get(collectionID);
        if (!collection) continue;
        let binding = ZotBindConfig.find(collection.libraryID, collection.key);
        if (binding && binding.enabled !== false) bindingIDs.add(binding.bindingID);
      }
    }
    else if (type === "collection") {
      for (let id of ids) {
        let collection = Zotero.Collections.get(Number(id));
        if (!collection) continue;
        let binding = ZotBindConfig.find(collection.libraryID, collection.key);
        if (binding && binding.enabled !== false) bindingIDs.add(binding.bindingID);
      }
    }
    else {
      let libraryIDs = ZotBindZoteroAdapter.affectedLibraryIDs(type, ids, extraData);
      for (let binding of ZotBindConfig.list()) {
        if (binding.enabled !== false && libraryIDs.has(binding.libraryID)) bindingIDs.add(binding.bindingID);
      }
      // Some file/delete notifications do not retain a resolvable item ID.
      // Reconcile active bindings conservatively so attachment availability
      // and deletion changes cannot remain stale.
      if (!libraryIDs.size && (type === "file" || event === "delete")) {
        for (let binding of ZotBindConfig.list()) {
          if (binding.enabled !== false && binding.lifecycleState === "active") bindingIDs.add(binding.bindingID);
        }
      }
    }
    for (let bindingID of bindingIDs) {
      ZotBindSync.requestBinding(bindingID, type + ":" + event).catch(error => Zotero.logError(error));
    }
  },

  resumePendingPrompts() {
    for (let binding of ZotBindConfig.list()) {
      if (binding.lifecycleState === "pendingCleanup") {
        ZotBindUI.promptPendingCleanup(binding.bindingID, Zotero.getMainWindow());
      }
    }
  },

  async stop() {
    if (!this.started) return;
    this.started = false;
    ZotBindZoteroAdapter.unregisterNotifier(this.notifierID);
    this.notifierID = null;
    try { Zotero.MenuManager.unregisterMenu(ZotBindUI.menuID); }
    catch (_) {}
    await ZotBindSync.shutdown();
    if (Zotero.ZotBind) delete Zotero.ZotBind;
  }
};
