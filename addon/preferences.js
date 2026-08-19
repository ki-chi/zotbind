const ZOTBIND_HTML_NS = "http://www.w3.org/1999/xhtml";

window.ZotBindPreferences = {
  initialized: false,
  selectedDirectory: null,

  init() {
    if (!Zotero.ZotBind) return;
    if (!this.initialized) {
      this.initialized = true;
      try { window.MozXULElement.insertFTLIfNeeded("zotbind.ftl"); }
      catch (_) {}
      this.populateCollections();
    }
    this.refresh();
  },

  populateCollections() {
    let popup = document.getElementById("zotbind-collection-popup");
    if (!popup) return;
    popup.replaceChildren();
    for (let collection of Zotero.ZotBind.listCollections()) {
      let item = document.createXULElement("menuitem");
      item.setAttribute("label", collection.libraryName + " — " + "  ".repeat(collection.level) + collection.collectionName);
      item.dataset.libraryID = collection.libraryID;
      item.dataset.collectionKey = collection.collectionKey;
      popup.append(item);
    }
    let picker = document.getElementById("zotbind-collection-picker");
    if (picker && popup.children.length && picker.selectedIndex < 0) picker.selectedIndex = 0;
  },

  async chooseNewDirectory() {
    let path = await Zotero.ZotBind.chooseDirectory(window, this.selectedDirectory);
    if (!path) return;
    this.selectedDirectory = path;
    document.getElementById("zotbind-new-directory").value = path;
  },

  async addBinding() {
    let picker = document.getElementById("zotbind-collection-picker");
    let item = picker && picker.selectedItem;
    if (!item || !this.selectedDirectory) {
      Services.prompt.alert(window, "ZotBind", "Choose a collection and papers directory first.");
      return;
    }
    try {
      await Zotero.ZotBind.addOrUpdateBinding({
        libraryID: Number(item.dataset.libraryID),
        collectionKey: item.dataset.collectionKey,
        destinationPath: this.selectedDirectory
      });
      this.selectedDirectory = null;
      document.getElementById("zotbind-new-directory").value = "";
      this.refresh();
    }
    catch (error) {
      Services.prompt.alert(window, "ZotBind", error.message || String(error));
    }
  },

  _button(label, handler) {
    let button = document.createElementNS(ZOTBIND_HTML_NS, "button");
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  },

  refresh() {
    if (!Zotero.ZotBind) return;
    let body = document.getElementById("zotbind-binding-rows");
    if (!body) return;
    body.replaceChildren();
    let bindings = Zotero.ZotBind.listBindings();
    document.getElementById("zotbind-empty-state").hidden = Boolean(bindings.length);
    for (let binding of bindings) {
      let status = Zotero.ZotBind.getStatus(binding.bindingID);
      let row = document.createElementNS(ZOTBIND_HTML_NS, "tr");
      let values = [
        Zotero.ZotBind.collectionLabel(binding),
        Zotero.ZotBind.libraryLabel(binding.libraryID),
        binding.destinationPath,
        status.state + " (" + (status.linked || 0) + " linked, " + ((status.errors || []).length) + " errors)",
        status.lastSync ? new Date(status.lastSync).toLocaleString() : "Never"
      ];
      for (let value of values) {
        let cell = document.createElementNS(ZOTBIND_HTML_NS, "td");
        cell.textContent = value;
        cell.title = value;
        row.append(cell);
      }
      let actions = document.createElementNS(ZOTBIND_HTML_NS, "td");
      actions.className = "zotbind-actions";
      if (binding.lifecycleState === "pendingCleanup") {
        actions.append(this._button("Resolve…", () => Zotero.ZotBind.resolvePendingCleanup(binding.bindingID, window)));
      }
      else if (binding.lifecycleState === "pendingDestinationChange") {
        actions.append(this._button("Retry new directory", () => Zotero.ZotBind.retryDestinationChange(binding.bindingID, window)));
        actions.append(this._button("Cancel change…", () => Zotero.ZotBind.cancelDestinationChange(binding.bindingID, window)));
      }
      else {
        actions.append(this._button("Sync", () => Zotero.ZotBind.syncNow(binding.bindingID)));
        actions.append(this._button(binding.enabled === false ? "Enable" : "Pause", () => Zotero.ZotBind.toggleBinding(binding.bindingID)));
      }
      actions.append(this._button("Open", () => Zotero.ZotBind.openDestination(binding.bindingID)));
      actions.append(this._button("Change…", async () => {
        let path = await Zotero.ZotBind.chooseDirectory(window, binding.destinationPath);
        if (path) await Zotero.ZotBind.changeDestination(binding.bindingID, path, window);
      }));
      actions.append(this._button("Details", () => Zotero.ZotBind.showStatus(binding.bindingID, window)));
      if ([...(status.errors || []), ...(status.warnings || [])].some(issue =>
        issue.code === "MANIFEST_CORRUPT" || issue.code === "MANIFEST_SCHEMA_UNSUPPORTED")) {
        actions.append(this._button("Rebuild manifest…", () => Zotero.ZotBind.rebuildManifest(binding.bindingID, window)));
      }
      if (binding.previousDestinationPath) {
        actions.append(this._button("Old directory…", () => Zotero.ZotBind.cleanupOldDestination(binding.bindingID, window)));
      }
      actions.append(this._button("Remove…", () => Zotero.ZotBind.removeBinding(binding.bindingID, window)));
      row.append(actions);
      body.append(row);
    }
  },

  async syncAll() {
    for (let binding of Zotero.ZotBind.listBindings()) {
      if (binding.enabled !== false && binding.lifecycleState === "active") {
        try { await Zotero.ZotBind.syncNow(binding.bindingID); }
        catch (error) { Zotero.logError(error); }
      }
    }
    this.refresh();
  },

  async removeAll() {
    try { await Zotero.ZotBind.removeAllBindings(window); }
    catch (error) { Services.prompt.alert(window, "ZotBind", error.message || String(error)); }
    this.refresh();
  }
};
