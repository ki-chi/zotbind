/* Collection-menu integration, prompts, and helpers shared by Preferences. */
var ZotBindUI = {
  pluginID: null,
  rootURI: null,
  menuID: "zotbind-collection-menu",
  preferencePaneID: "zotbind-preferences",
  loadedWindows: new WeakSet(),

  async init({ id, rootURI }) {
    this.pluginID = id;
    this.rootURI = rootURI;
    await Zotero.PreferencePanes.register({
      pluginID: id,
      src: rootURI + "preferences.xhtml",
      id: this.preferencePaneID,
      label: "ZotBind",
      image: rootURI + "icons/zotbind.svg",
      scripts: [rootURI + "preferences.js"],
      stylesheets: [rootURI + "preferences.css"]
    });

    Zotero.MenuManager.registerMenu({
      menuID: this.menuID,
      pluginID: id,
      target: "main/library/collection",
      menus: [{
        menuType: "submenu",
        l10nID: "zotbind-menu-root",
        icon: rootURI + "icons/zotbind.svg",
        onShowing: (_event, context) => context.setVisible(Boolean(context.collectionTreeRow && context.collectionTreeRow.isCollection())),
        menus: [
          {
            menuType: "menuitem",
            l10nID: "zotbind-menu-set-directory",
            onCommand: (_event, context) => this.setDirectoryForContext(context)
          },
          {
            menuType: "menuitem",
            l10nID: "zotbind-menu-sync-now",
            onShowing: (_event, context) => context.setEnabled(Boolean(this.bindingForContext(context))),
            onCommand: (_event, context) => this.syncContext(context)
          },
          {
            menuType: "menuitem",
            l10nID: "zotbind-menu-status",
            onShowing: (_event, context) => context.setEnabled(Boolean(this.bindingForContext(context))),
            onCommand: (_event, context) => this.showContextStatus(context)
          },
          { menuType: "separator" },
          {
            menuType: "menuitem",
            l10nID: "zotbind-menu-remove-binding",
            onShowing: (_event, context) => context.setEnabled(Boolean(this.bindingForContext(context))),
            onCommand: (_event, context) => this.removeContextBinding(context)
          },
          {
            menuType: "menuitem",
            l10nID: "zotbind-menu-preferences",
            onCommand: () => Zotero.Utilities.Internal.openPreferences(this.preferencePaneID)
          }
        ]
      }]
    });
  },

  async onMainWindowLoad(window) {
    if (this.loadedWindows.has(window)) return;
    this.loadedWindows.add(window);
    window.MozXULElement.insertFTLIfNeeded("zotbind.ftl");
  },

  onMainWindowUnload(window) {
    this.loadedWindows.delete(window);
  },

  contextCollection(context) {
    let row = context && context.collectionTreeRow;
    return row && row.isCollection() ? row.ref : null;
  },

  bindingForContext(context) {
    let collection = this.contextCollection(context);
    return collection ? ZotBindConfig.find(collection.libraryID, collection.key) : null;
  },

  contextWindow(context) {
    return context && context.menuElem && context.menuElem.ownerGlobal || Zotero.getMainWindow();
  },

  async chooseDirectory(window, initialPath) {
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    let picker = new FilePicker();
    picker.init(window, "Choose a papers directory", picker.modeGetFolder);
    if (initialPath) {
      try { picker.displayDirectory = initialPath; }
      catch (_) {}
    }
    let result = await picker.show();
    return result === picker.returnOK ? ZotBindCore.filePickerPath(picker.file) : null;
  },

  async setDirectoryForContext(context) {
    let collection = this.contextCollection(context);
    if (!collection) return;
    let existing = ZotBindConfig.find(collection.libraryID, collection.key);
    let path = await this.chooseDirectory(this.contextWindow(context), existing && existing.destinationPath);
    if (!path) return;
    try {
      let result = await ZotBindRuntime.addOrUpdateBinding({ libraryID: collection.libraryID, collectionKey: collection.key, destinationPath: path });
      if (result && result.state === "Error") {
        this.showStatus(ZotBindConfig.find(collection.libraryID, collection.key).bindingID, this.contextWindow(context));
      }
    }
    catch (error) {
      Services.prompt.alert(this.contextWindow(context), "ZotBind", error.message || String(error));
    }
  },

  async syncContext(context) {
    let binding = this.bindingForContext(context);
    if (!binding) return;
    try { await ZotBindSync.requestBinding(binding.bindingID, "manual", { immediate: true }); }
    catch (error) { Services.prompt.alert(this.contextWindow(context), "ZotBind", error.message || String(error)); }
  },

  showContextStatus(context) {
    let binding = this.bindingForContext(context);
    if (binding) this.showStatus(binding.bindingID, this.contextWindow(context));
  },

  showStatus(bindingID, window) {
    let status = ZotBindConfig.getStatus(bindingID);
    let lines = [
      "Status: " + status.state,
      "Linked: " + (status.linked || 0),
      "Skipped: " + (status.skipped || 0),
      "Last sync: " + (status.lastSync || "Never")
    ];
    let issues = [...(status.errors || []), ...(status.warnings || [])];
    if (issues.length) {
      lines.push("", "Details:");
      for (let issue of issues) lines.push("• [" + issue.code + "] " + issue.message);
    }
    Services.prompt.alert(window || Zotero.getMainWindow(), "ZotBind", lines.join("\n"));
  },

  async removeContextBinding(context) {
    let binding = this.bindingForContext(context);
    if (binding) await this.promptRemoveBinding(binding.bindingID, this.contextWindow(context));
  },

  _threeButton(window, title, message, first, second, third) {
    let prompt = Services.prompt;
    let flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING +
      prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING +
      prompt.BUTTON_POS_2 * prompt.BUTTON_TITLE_IS_STRING;
    return prompt.confirmEx(window, title, message, flags, first, second, third, null, {});
  },

  async promptRemoveBinding(bindingID, window) {
    let binding = ZotBindConfig.get(bindingID);
    if (!binding) return false;
    let choice = this._threeButton(
      window || Zotero.getMainWindow(),
      "Remove ZotBind binding",
      "Remove this collection binding? Files not managed by ZotBind will never be deleted.",
      "Remove managed links",
      "Keep links",
      "Cancel"
    );
    if (choice === 2) return false;
    try {
      await ZotBindSync.detachAtDestination(binding, binding.destinationPath, choice === 0);
      ZotBindConfig.remove(bindingID);
      return true;
    }
    catch (error) {
      Services.prompt.alert(window || Zotero.getMainWindow(), "ZotBind", "The binding was not removed.\n\n" + (error.message || String(error)));
      return false;
    }
  },

  async promptPendingCleanup(bindingID, window) {
    let binding = ZotBindConfig.get(bindingID);
    if (!binding || binding.lifecycleState !== "pendingCleanup") return;
    let choice = this._threeButton(
      window || Zotero.getMainWindow(),
      "Deleted Zotero collection",
      "A collection bound by ZotBind was deleted. What should happen to its managed links?",
      "Remove managed links",
      "Keep links",
      "Decide later"
    );
    if (choice === 2) return;
    try {
      await ZotBindSync.detachAtDestination(binding, binding.destinationPath, choice === 0);
      ZotBindConfig.remove(bindingID);
    }
    catch (error) {
      Services.prompt.alert(window || Zotero.getMainWindow(), "ZotBind", "Cleanup could not be completed. The decision remains pending.\n\n" + (error.message || String(error)));
    }
  },

  async promptOldDestinationCleanup(binding, oldPath, window) {
    let prompt = Services.prompt;
    let flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING +
      prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING;
    let choice = prompt.confirmEx(
      window || Zotero.getMainWindow(),
      "New destination synchronized",
      "The new papers directory is synchronized. Remove this binding's managed links from the old directory?\n\n" + oldPath,
      flags,
      "Remove old managed links",
      "Keep old links",
      null,
      null,
      {}
    );
    await ZotBindSync.detachAtDestination(binding, oldPath, choice === 0);
  },

  refreshOpenPanes() {
    for (let window of Services.wm.getEnumerator("zotero:pref")) {
      try {
        if (window.ZotBindPreferences) window.ZotBindPreferences.refresh();
      }
      catch (_) {}
    }
  }
};
