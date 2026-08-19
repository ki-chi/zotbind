/* Zotero preference-backed binding and durable status repository. */
var ZotBindConfig = {
  BINDINGS_PREF: "extensions.zotbind.bindings",
  STATUSES_PREF: "extensions.zotbind.statuses",
  bindings: [],
  statuses: {},

  init() {
    let configVersion = Number(Zotero.Prefs.get("extensions.zotbind.configVersion", true) || 0);
    if (configVersion > 1) {
      throw ZotBindCore.codedError("CONFIG_SCHEMA_UNSUPPORTED", "This ZotBind configuration was created by a newer version.");
    }
    this.bindings = this._readJSON(this.BINDINGS_PREF, []);
    this.statuses = this._readJSON(this.STATUSES_PREF, {});
    this.bindings = this.bindings.map(binding => this._normalizeBinding(binding));
    Zotero.Prefs.set("extensions.zotbind.configVersion", 1, true);
    this._saveBindings();
  },

  _readJSON(pref, fallback) {
    try {
      let raw = Zotero.Prefs.get(pref, true);
      return raw ? JSON.parse(raw) : ZotBindCore.clone(fallback);
    }
    catch (error) {
      Zotero.logError(error);
      return ZotBindCore.clone(fallback);
    }
  },

  _normalizeBinding(binding) {
    return {
      bindingID: binding.bindingID || ZotBindCore.uuid(),
      libraryID: Number(binding.libraryID),
      collectionKey: String(binding.collectionKey || ""),
      destinationPath: String(binding.destinationPath || ""),
      enabled: binding.enabled !== false,
      lifecycleState: binding.lifecycleState || (binding.enabled === false ? "paused" : "active"),
      pendingDestinationPath: binding.pendingDestinationPath || null,
      previousDestinationPath: binding.previousDestinationPath || null,
      createdAt: binding.createdAt || new Date().toISOString(),
      updatedAt: binding.updatedAt || new Date().toISOString()
    };
  },

  _saveBindings() {
    Zotero.Prefs.set(this.BINDINGS_PREF, JSON.stringify(this.bindings), true);
    this._notifyUI();
  },

  _saveStatuses() {
    Zotero.Prefs.set(this.STATUSES_PREF, JSON.stringify(this.statuses), true);
    this._notifyUI();
  },

  _notifyUI() {
    try {
      if (typeof ZotBindUI !== "undefined") ZotBindUI.refreshOpenPanes();
    }
    catch (error) {
      Zotero.logError(error);
    }
  },

  list() {
    return ZotBindCore.clone(this.bindings);
  },

  listForDestination(destinationPath) {
    let key = ZotBindFilesystem ? ZotBindFilesystem.pathKey(destinationPath) : destinationPath;
    return this.bindings.filter(binding => {
      let candidate = binding.lifecycleState === "pendingDestinationChange" && binding.pendingDestinationPath
        ? [binding.destinationPath, binding.pendingDestinationPath]
        : [binding.destinationPath];
      return candidate.some(path => (ZotBindFilesystem ? ZotBindFilesystem.pathKey(path) : path) === key);
    }).map(binding => ZotBindCore.clone(binding));
  },

  get(bindingID) {
    let binding = this.bindings.find(value => value.bindingID === bindingID);
    return binding ? ZotBindCore.clone(binding) : null;
  },

  find(libraryID, collectionKey) {
    let binding = this.bindings.find(value => value.libraryID === Number(libraryID) && value.collectionKey === collectionKey);
    return binding ? ZotBindCore.clone(binding) : null;
  },

  upsert(input) {
    let now = new Date().toISOString();
    let existingIndex = input.bindingID
      ? this.bindings.findIndex(value => value.bindingID === input.bindingID)
      : this.bindings.findIndex(value => value.libraryID === Number(input.libraryID) && value.collectionKey === input.collectionKey);
    let next = this._normalizeBinding({
      ...(existingIndex >= 0 ? this.bindings[existingIndex] : {}),
      ...input,
      updatedAt: now
    });
    if (existingIndex >= 0) this.bindings.splice(existingIndex, 1, next);
    else this.bindings.push(next);
    this._saveBindings();
    return ZotBindCore.clone(next);
  },

  remove(bindingID) {
    let before = this.bindings.length;
    this.bindings = this.bindings.filter(value => value.bindingID !== bindingID);
    delete this.statuses[bindingID];
    if (before !== this.bindings.length) {
      this._saveBindings();
      this._saveStatuses();
      return true;
    }
    return false;
  },

  getStatus(bindingID) {
    return ZotBindCore.clone(this.statuses[bindingID] || {
      state: "Warning",
      linked: 0,
      skipped: 0,
      errors: [],
      warnings: [],
      lastSync: null,
      lastSuccess: null,
      message: "Not synchronized yet"
    });
  },

  setStatus(bindingID, patch) {
    let previous = this.getStatus(bindingID);
    let status = { ...previous, ...ZotBindCore.clone(patch) };
    if (!status.state) status.state = ZotBindCore.statusState(status);
    this.statuses[bindingID] = status;
    this._saveStatuses();
    return ZotBindCore.clone(status);
  },

  setStatuses(updates) {
    for (let [bindingID, patch] of Object.entries(updates)) {
      this.statuses[bindingID] = { ...this.getStatus(bindingID), ...ZotBindCore.clone(patch) };
    }
    this._saveStatuses();
  },

  markCollectionDeleted(libraryID, collectionKey) {
    let changed = [];
    for (let binding of this.bindings) {
      if (binding.libraryID === Number(libraryID) && binding.collectionKey === collectionKey) {
        binding.enabled = false;
        binding.lifecycleState = "pendingCleanup";
        binding.updatedAt = new Date().toISOString();
        changed.push(binding.bindingID);
        this.statuses[binding.bindingID] = {
          ...this.getStatus(binding.bindingID),
          state: "Action required",
          message: "The Zotero collection was deleted. Choose whether to remove or keep its links."
        };
      }
    }
    if (changed.length) {
      this._saveBindings();
      this._saveStatuses();
    }
    return changed;
  }
};
