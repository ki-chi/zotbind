/* Zotero 9 API adapter. Domain reconciliation does not call Zotero APIs directly. */
var ZotBindZoteroAdapter = {
  getCollection(libraryID, collectionKey) {
    return Zotero.Collections.getByLibraryAndKey(Number(libraryID), collectionKey);
  },

  collectionLabel(binding) {
    let collection = this.getCollection(binding.libraryID, binding.collectionKey);
    return collection ? collection.name : "[Deleted collection]";
  },

  libraryLabel(libraryID) {
    let library = Zotero.Libraries.get(Number(libraryID));
    return library ? library.name : "Library " + libraryID;
  },

  listCollections() {
    let output = [];
    for (let library of Zotero.Libraries.getAll()) {
      let collections = Zotero.Collections.getByLibrary(library.libraryID, true, false) || [];
      for (let collection of collections) {
        output.push({
          libraryID: library.libraryID,
          libraryName: library.name,
          collectionKey: collection.key,
          collectionName: collection.name,
          level: this._collectionLevel(collection)
        });
      }
    }
    return output.sort((a, b) => {
      let libraryOrder = a.libraryName.localeCompare(b.libraryName);
      return libraryOrder || a.collectionName.localeCompare(b.collectionName);
    });
  },

  _collectionLevel(collection) {
    let level = 0;
    let current = collection;
    while (current && current.parentID && level < 30) {
      level++;
      current = Zotero.Collections.get(current.parentID);
    }
    return level;
  },

  /** Resolve the direct members of one active collection binding. */
  async resolveBinding(binding, oldManifest) {
    let records = [];
    let errors = [];
    let warnings = [];
    let protectedOwnership = new Set();
    let skipped = 0;
    let collection = this.getCollection(binding.libraryID, binding.collectionKey);
    if (!collection) {
      errors.push(ZotBindCore.makeIssue(
        "COLLECTION_NOT_FOUND",
        "The bound collection no longer exists.",
        { bindingID: binding.bindingID, collectionKey: binding.collectionKey }
      ));
      return { records, errors, warnings, protectedOwnership, skipped, collectionMissing: true };
    }

    // getChildItems(false, false) is direct membership only and excludes Trash.
    let items = collection.getChildItems(false, false);
    for (let item of items) {
      if (!item || !item.isRegularItem()) {
        skipped++;
        continue;
      }
      let identity = ZotBindCore.identityKey(binding.libraryID, item.key);
      let ownership = ZotBindCore.ownershipKey(binding.bindingID, binding.libraryID, item.key);
      let citationKey;
      try {
        citationKey = item.getField("citationKey");
      }
      catch (error) {
        protectedOwnership.add(ownership);
        warnings.push(ZotBindCore.makeIssue(
          "CITATION_KEY_READ_FAILED",
          "Citation key could not be read; the last managed filename is being kept.",
          { bindingID: binding.bindingID, itemKey: item.key, details: String(error) }
        ));
        continue;
      }

      let attachment;
      try {
        attachment = await item.getBestAttachment();
      }
      catch (error) {
        errors.push(ZotBindCore.makeIssue(
          "PRIMARY_PDF_NOT_FOUND",
          "Zotero could not determine the primary attachment.",
          { bindingID: binding.bindingID, itemKey: item.key, details: String(error) }
        ));
        continue;
      }
      if (!attachment || !attachment.isPDFAttachment()) {
        errors.push(ZotBindCore.makeIssue(
          "PRIMARY_PDF_NOT_FOUND",
          "No primary PDF attachment was found.",
          { bindingID: binding.bindingID, itemKey: item.key }
        ));
        continue;
      }

      let target;
      try { target = await attachment.getFilePathAsync(); }
      catch (_) { target = false; }
      if (!target || !(await ZotBindFilesystem.sourceIsUsable(target))) {
        errors.push(ZotBindCore.makeIssue(
          "PDF_NOT_LOCAL",
          "The primary PDF is not available locally.",
          { bindingID: binding.bindingID, itemKey: item.key, attachmentKey: attachment.key }
        ));
        continue;
      }

      let filename;
      try { filename = ZotBindCore.resolveFilename(citationKey, item.key); }
      catch (error) {
        protectedOwnership.add(ownership);
        errors.push(ZotBindCore.makeIssue(
          "INVALID_FILENAME",
          "A safe PDF filename could not be generated.",
          { bindingID: binding.bindingID, itemKey: item.key, details: String(error) }
        ));
        continue;
      }
      records.push({
        filename,
        target,
        itemLibraryID: Number(binding.libraryID),
        itemKey: item.key,
        itemIdentity: identity,
        attachmentKey: attachment.key,
        citationKey: citationKey ? String(citationKey) : null,
        bindings: [{
          bindingID: binding.bindingID,
          libraryID: Number(binding.libraryID),
          collectionKey: binding.collectionKey
        }]
      });
    }
    return { records, errors, warnings, protectedOwnership, skipped, collectionMissing: false };
  },

  resolutionSignature(result) {
    let records = result.records.map(record => [
      record.itemLibraryID,
      record.itemKey,
      record.attachmentKey,
      record.citationKey || "",
      record.filename,
      record.target
    ]).sort((a, b) => a.join("|").localeCompare(b.join("|")));
    let errors = result.errors.map(issue => [issue.code, issue.itemKey || "", issue.attachmentKey || ""])
      .sort((a, b) => a.join("|").localeCompare(b.join("|")));
    let warnings = result.warnings.map(issue => [issue.code, issue.itemKey || ""])
      .sort((a, b) => a.join("|").localeCompare(b.join("|")));
    return JSON.stringify({ records, errors, warnings, skipped: result.skipped });
  },

  registerNotifier(callback) {
    let observer = {
      notify: async (event, type, ids, extraData) => {
        try { await callback(event, type, ids, extraData || {}); }
        catch (error) { Zotero.logError(error); }
      }
    };
    return Zotero.Notifier.registerObserver(
      observer,
      ["item", "collection", "collection-item", "file"],
      "zotbind"
    );
  },

  unregisterNotifier(observerID) {
    if (observerID) Zotero.Notifier.unregisterObserver(observerID);
  },

  deletedObjectIdentity(type, id, extraData) {
    let data = extraData && extraData[id];
    if (!data) return null;
    if (type === "collection" && data.libraryID != null && data.key) {
      return { libraryID: Number(data.libraryID), collectionKey: data.key };
    }
    return null;
  },

  affectedLibraryIDs(type, ids, extraData) {
    let libraryIDs = new Set();
    if (type === "collection-item") {
      for (let compoundID of ids) {
        let collectionID = Number(String(compoundID).split("-")[0]);
        let collection = Zotero.Collections.get(collectionID);
        if (collection) libraryIDs.add(collection.libraryID);
      }
    }
    else if (type === "collection") {
      for (let id of ids) {
        let object = Zotero.Collections.get(Number(id));
        let data = extraData && extraData[id];
        let libraryID = object && object.libraryID || data && data.libraryID;
        if (libraryID != null) libraryIDs.add(Number(libraryID));
      }
    }
    else {
      for (let id of ids) {
        let item = Zotero.Items.get(Number(id));
        let data = extraData && extraData[id];
        let libraryID = item && item.libraryID || data && data.libraryID;
        if (libraryID != null) libraryIDs.add(Number(libraryID));
      }
    }
    return libraryIDs;
  }
};
