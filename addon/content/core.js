/* Pure synchronization-domain helpers. Kept free of Zotero APIs for tests. */
(function (root, factory) {
  let api = factory();
  root.ZotBindCore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MANIFEST_SCHEMA_VERSION = 1;
  const MANIFEST_NAME = ".zotero-paper-links.json";
  const JOURNAL_NAME = ".zotero-paper-links.transaction.json";
  const MAX_COMPONENT_BYTES = 240;
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

  function uuid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      let r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
  }

  function utf8Length(value) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
    return unescape(encodeURIComponent(value)).length;
  }

  function truncateUTF8(value, maxBytes) {
    let output = "";
    for (let character of value) {
      if (utf8Length(output + character) > maxBytes) break;
      output += character;
    }
    return output;
  }

  /**
   * Make a citation/item key safe as one path component on every supported OS.
   * NFC is used, control and Windows-invalid characters become underscores,
   * trailing Windows dots/spaces are removed, reserved DOS names are prefixed,
   * and the UTF-8 component length is capped. The raw key remains in manifest.
   */
  function sanitizeBasename(raw, fallback) {
    let value = String(raw == null ? "" : raw).normalize("NFC");
    value = value.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_");
    value = value.replace(/[. ]+$/g, "").trim();
    if (!value || value === "." || value === "..") {
      value = String(fallback || "item").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_");
    }
    if (WINDOWS_RESERVED.test(value)) value = "_" + value;
    value = truncateUTF8(value, MAX_COMPONENT_BYTES - utf8Length(".pdf"));
    value = value.replace(/[. ]+$/g, "");
    if (!value || value === "." || value === "..") value = "item";
    return value;
  }

  function resolveFilename(citationKey, itemKey) {
    let confirmedCitationKey = citationKey == null ? "" : String(citationKey).trim();
    let logicalKey = confirmedCitationKey || String(itemKey);
    return sanitizeBasename(logicalKey, itemKey) + ".pdf";
  }

  // Zotero 9's FilePicker returns a path string. Accepting nsIFile-shaped
  // values as well keeps this adapter tolerant of future/platform variants.
  function filePickerPath(value) {
    if (typeof value === "string") return value || null;
    if (value && typeof value.path === "string") return value.path || null;
    return null;
  }

  function identityKey(libraryID, itemKey) {
    return String(libraryID) + ":" + String(itemKey);
  }

  function ownershipKey(bindingID, libraryID, itemKey) {
    return [bindingID, libraryID, itemKey].join("|");
  }

  function bindingFingerprint(bindings) {
    return bindings.map(binding => [
      binding.bindingID,
      binding.libraryID,
      binding.collectionKey,
      binding.enabled !== false,
      binding.lifecycleState || "active"
    ].join(":"))
      .sort()
      .join(";");
  }

  function emptyManifest(destinationID) {
    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      generator: "zotbind",
      destinationID: destinationID || uuid(),
      generation: 0,
      lastTransactionID: null,
      bindingFingerprint: "",
      updatedAt: null,
      links: {}
    };
  }

  /**
   * Manifest migrations are deliberately explicit and one-way. Version 0 was
   * used only by early development builds and already had compatible link
   * records; migration adds committed-generation metadata without touching
   * filesystem entries.
   */
  function migrateManifest(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw codedError("MANIFEST_CORRUPT", "Manifest root must be an object");
    }
    let value = clone(input);
    if (value.schemaVersion === 0 && value.generator === "zotbind" && value.links && typeof value.links === "object") {
      value.schemaVersion = 1;
      value.destinationID = value.destinationID || uuid();
      value.generation = Number.isInteger(value.generation) ? value.generation : 0;
      value.lastTransactionID = value.lastTransactionID || null;
      value.bindingFingerprint = value.bindingFingerprint || "";
      value.updatedAt = value.updatedAt || null;
    }
    return validateManifest(value);
  }

  function validateManifest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw codedError("MANIFEST_CORRUPT", "Manifest root must be an object");
    }
    if (value.generator !== "zotbind") {
      throw codedError("MANIFEST_CORRUPT", "Manifest generator is not zotbind");
    }
    if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
      throw codedError("MANIFEST_SCHEMA_UNSUPPORTED", "Unsupported manifest schema: " + value.schemaVersion);
    }
    if (!value.destinationID || !Number.isInteger(value.generation) || !value.links || typeof value.links !== "object") {
      throw codedError("MANIFEST_CORRUPT", "Manifest is missing required fields");
    }
    for (let [filename, record] of Object.entries(value.links)) {
      if (!filename || filename.includes("/") || filename.includes("\\") || !record ||
          typeof record.target !== "string" || !record.itemKey || !Array.isArray(record.bindings)) {
        throw codedError("MANIFEST_CORRUPT", "Invalid link record: " + filename);
      }
      let absoluteTarget = record.target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(record.target) || /^\\\\[^\\]+\\/.test(record.target);
      if (!absoluteTarget || record.target.includes("\u0000") || (record.filename && record.filename !== filename)) {
        throw codedError("MANIFEST_CORRUPT", "Unsafe link record: " + filename);
      }
      for (let binding of record.bindings) {
        if (!binding.bindingID || binding.libraryID == null || !binding.collectionKey) {
          throw codedError("MANIFEST_CORRUPT", "Invalid binding ownership: " + filename);
        }
      }
    }
    return value;
  }

  function codedError(code, message, details) {
    let error = new Error(message);
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uniqueBindings(bindings) {
    let seen = new Set();
    return bindings.filter(binding => {
      if (seen.has(binding.bindingID)) return false;
      seen.add(binding.bindingID);
      return true;
    }).sort((a, b) => a.bindingID.localeCompare(b.bindingID));
  }

  /** Aggregate desired records and report filename collisions by durable item identity. */
  function aggregateDesired(records) {
    let byFilename = new Map();
    for (let record of records) {
      let identity = identityKey(record.itemLibraryID, record.itemKey);
      // Use a portable collision key. This is intentionally conservative on
      // case-sensitive Linux filesystems so one manifest behaves identically
      // when a project directory is moved to default macOS/Windows storage.
      let collisionKey = String(record.filename).normalize("NFC").toLocaleLowerCase("en-US");
      let group = byFilename.get(collisionKey);
      if (!group) {
        group = { filenames: new Set(), byIdentity: new Map() };
        byFilename.set(collisionKey, group);
      }
      group.filenames.add(record.filename);
      let aggregate = group.byIdentity.get(identity);
      if (!aggregate) {
        aggregate = { ...clone(record), bindings: [] };
        group.byIdentity.set(identity, aggregate);
      }
      if (aggregate.target !== record.target || aggregate.attachmentKey !== record.attachmentKey) {
        aggregate.sourceConflict = true;
      }
      aggregate.bindings.push(...record.bindings);
      aggregate.bindings = uniqueBindings(aggregate.bindings);
    }

    let desired = new Map();
    let collisions = [];
    for (let group of byFilename.values()) {
      let identities = Array.from(group.byIdentity.keys());
      let recordsForName = Array.from(group.byIdentity.values());
      if (identities.length > 1 || group.filenames.size > 1 || recordsForName.some(record => record.sourceConflict)) {
        collisions.push({ filename: Array.from(group.filenames).join(" / "), identities, records: recordsForName });
      }
      else {
        let filename = Array.from(group.filenames)[0];
        desired.set(filename, recordsForName[0]);
      }
    }
    return { desired, collisions };
  }

  function makeIssue(code, message, fields) {
    return { code, message, ...(fields || {}) };
  }

  /** Pure ownership transition used after successful, non-destructive upserts. */
  function buildOwnershipState(oldManifest, activeBindingIDs, protectedOwnership, successfulRecords) {
    let next = clone(oldManifest);
    let active = new Set(activeBindingIDs);
    let protectedSet = new Set(protectedOwnership);
    for (let record of Object.values(next.links)) {
      record.bindings = record.bindings.filter(owner => {
        if (!active.has(owner.bindingID)) return true;
        return protectedSet.has(ownershipKey(owner.bindingID, record.itemLibraryID, record.itemKey));
      });
    }
    for (let record of successfulRecords) {
      let desired = clone(record);
      let current = next.links[desired.filename];
      if (current && identityKey(current.itemLibraryID, current.itemKey) === identityKey(desired.itemLibraryID, desired.itemKey)) {
        desired.bindings = uniqueBindings([...current.bindings, ...desired.bindings]);
      }
      next.links[desired.filename] = desired;
    }
    return next;
  }

  /** Pure safety classification for a desired path. */
  function assessCandidate(desired, oldAtPath, actual, frozenBindingIDs) {
    let frozen = new Set(frozenBindingIDs || []);
    let desiredIdentity = identityKey(desired.itemLibraryID, desired.itemKey);
    let oldIdentity = oldAtPath && identityKey(oldAtPath.itemLibraryID, oldAtPath.itemKey);
    if (oldAtPath && oldAtPath.bindings.some(owner => frozen.has(owner.bindingID)) &&
        (oldIdentity !== desiredIdentity || oldAtPath.target !== desired.target)) {
      return makeIssue("FROZEN_LINK_CONFLICT", "A paused binding freezes the existing managed link", { filename: desired.filename });
    }
    if (oldAtPath && oldIdentity !== desiredIdentity) {
      return makeIssue("FILENAME_COLLISION", "The managed filename belongs to another Zotero item", { filename: desired.filename });
    }
    if (!oldAtPath && actual.type !== "none") {
      return makeIssue("UNMANAGED_PATH_CONFLICT", "An unmanaged filesystem object occupies the desired path", { filename: desired.filename, actualType: actual.type });
    }
    if (oldAtPath && actual.type !== "none" && actual.type !== "symlink") {
      return makeIssue("UNMANAGED_PATH_CONFLICT", "A non-symlink occupies a manifest-owned path", { filename: desired.filename, actualType: actual.type });
    }
    return null;
  }

  function statusState(status) {
    if (status.lifecycleState === "pendingCleanup" || status.lifecycleState === "pendingDestinationChange") return "Action required";
    if (status.syncing) return "Syncing";
    if ((status.errors || []).length) return "Error";
    if ((status.warnings || []).length) return "Warning";
    if (status.enabled === false) return "Paused";
    return "Synced";
  }

  return {
    MANIFEST_SCHEMA_VERSION,
    MANIFEST_NAME,
    JOURNAL_NAME,
    MAX_COMPONENT_BYTES,
    uuid,
    utf8Length,
    truncateUTF8,
    sanitizeBasename,
    resolveFilename,
    filePickerPath,
    identityKey,
    ownershipKey,
    bindingFingerprint,
    emptyManifest,
    migrateManifest,
    validateManifest,
    codedError,
    clone,
    uniqueBindings,
    aggregateDesired,
    makeIssue,
    buildOwnershipState,
    assessCandidate,
    statusState
  };
});
