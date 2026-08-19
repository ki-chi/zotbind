/* Destination-wide serialized reconciliation and crash recovery. */
var ZotBindSync = {
  jobs: new Map(),
  stopping: false,
  retryDelays: [5000, 30000, 300000],

  init() {
    this.stopping = false;
    this.jobs = new Map();
  },

  _bindingsAt(destinationPath) {
    let key = ZotBindFilesystem.pathKey(destinationPath);
    return ZotBindConfig.list().filter(binding => ZotBindFilesystem.pathKey(binding.destinationPath) === key);
  },

  _active(binding) {
    return binding.enabled !== false && binding.lifecycleState === "active";
  },

  async startupCheck() {
    let seen = new Set();
    for (let binding of ZotBindConfig.list()) {
      let key = ZotBindFilesystem.pathKey(binding.destinationPath);
      if (!binding.destinationPath || seen.has(key)) continue;
      seen.add(key);
      try {
        await ZotBindFilesystem.assertDestination(binding.destinationPath);
        let journal = await ZotBindFilesystem.readJournal(binding.destinationPath);
        if (journal) {
          await this.recover(binding.destinationPath);
          this.requestDestination(binding.destinationPath, "startup-recovery", { immediate: true });
          continue;
        }
        let manifest = await ZotBindFilesystem.readManifest(binding.destinationPath, true);
        let expectedFingerprint = ZotBindCore.bindingFingerprint(this._bindingsAt(binding.destinationPath));
        let inconsistent = !manifest || manifest.bindingFingerprint !== expectedFingerprint;
        if (manifest && !inconsistent) {
          for (let [filename, record] of Object.entries(manifest.links)) {
            let actual = await ZotBindFilesystem.classify(ZotBindFilesystem.linkPath(binding.destinationPath, filename));
            if (actual.type !== "symlink" || !actual.target || !ZotBindFilesystem.pathsEqual(actual.target, record.target)) {
              inconsistent = true;
              break;
            }
          }
        }
        // Metadata-only source signatures catch changes made while ZotBind was
        // disabled without performing any destination mutations on a clean start.
        if (manifest && !inconsistent) {
          for (let sourceBinding of this._bindingsAt(binding.destinationPath).filter(value => this._active(value))) {
            let resolution = await ZotBindZoteroAdapter.resolveBinding(sourceBinding, manifest);
            let signature = ZotBindZoteroAdapter.resolutionSignature(resolution);
            if (!manifest.sourceSignatures || manifest.sourceSignatures[sourceBinding.bindingID] !== signature) {
              inconsistent = true;
              break;
            }
          }
        }
        if (inconsistent) this.requestDestination(binding.destinationPath, "startup-consistency", { immediate: true });
      }
      catch (error) {
        this._setDestinationError(binding.destinationPath, error);
        if (error.code === "DESTINATION_UNAVAILABLE" || error.code === "DESTINATION_PERMISSION_DENIED") {
          this._scheduleRetry(binding.destinationPath);
        }
      }
    }
  },

  requestBinding(bindingID, reason, options) {
    let binding = ZotBindConfig.get(bindingID);
    if (!binding) return Promise.resolve(null);
    return this.requestDestination(binding.destinationPath, reason, options);
  },

  requestDestination(destinationPath, reason, options = {}) {
    if (this.stopping) return Promise.resolve(null);
    let key = ZotBindFilesystem.pathKey(destinationPath);
    let job = this.jobs.get(key);
    if (!job) {
      job = {
        key,
        destinationPath,
        running: false,
        pending: false,
        timer: null,
        retryTimer: null,
        retryIndex: 0,
        waiters: [],
        reasons: new Set()
      };
      this.jobs.set(key, job);
    }
    job.destinationPath = destinationPath;
    job.pending = true;
    job.reasons.add(reason || "unspecified");
    if (options.resetRetry !== false) job.retryIndex = 0;
    let promise = new Promise((resolve, reject) => job.waiters.push({ resolve, reject }));
    if (job.timer) clearTimeout(job.timer);
    let delay = options.immediate ? 0 : 400;
    job.timer = setTimeout(() => {
      job.timer = null;
      this._runJob(job).catch(error => Zotero.logError(error));
    }, delay);
    return promise;
  },

  async _runJob(job) {
    if (job.running || this.stopping) return;
    job.running = true;
    let finalResult = null;
    let finalError = null;
    try {
      while (job.pending && !this.stopping) {
        job.pending = false;
        let reasons = Array.from(job.reasons);
        job.reasons.clear();
        try {
          finalResult = await this.reconcileDestination(job.destinationPath, { reasons });
          finalError = null;
          job.retryIndex = 0;
        }
        catch (error) {
          finalError = error;
          this._setDestinationError(job.destinationPath, error);
          if (error.code === "DESTINATION_UNAVAILABLE" || error.code === "DESTINATION_PERMISSION_DENIED") {
            this._scheduleRetry(job.destinationPath);
          }
        }
      }
    }
    finally {
      job.running = false;
      let waiters = job.waiters.splice(0);
      for (let waiter of waiters) {
        if (finalError) waiter.reject(finalError);
        else waiter.resolve(finalResult);
      }
      if (job.pending && !this.stopping) this._runJob(job).catch(error => Zotero.logError(error));
    }
  },

  _scheduleRetry(destinationPath) {
    if (this.stopping) return;
    let key = ZotBindFilesystem.pathKey(destinationPath);
    let job = this.jobs.get(key);
    if (!job) {
      job = { key, destinationPath, running: false, pending: false, timer: null, retryTimer: null, retryIndex: 0, waiters: [], reasons: new Set() };
      this.jobs.set(key, job);
    }
    if (job.retryTimer || job.retryIndex >= this.retryDelays.length) return;
    let delay = this.retryDelays[job.retryIndex++];
    job.retryTimer = setTimeout(() => {
      job.retryTimer = null;
      this.requestDestination(destinationPath, "bounded-retry", { immediate: true, resetRetry: false }).catch(() => {});
    }, delay);
  },

  _setDestinationError(destinationPath, error) {
    let updates = {};
    let now = new Date().toISOString();
    for (let binding of this._bindingsAt(destinationPath)) {
      updates[binding.bindingID] = {
        state: binding.lifecycleState === "pendingCleanup" ? "Action required" : "Error",
        errors: [ZotBindCore.makeIssue(error.code || "SYNC_FAILED", error.message || String(error), { details: error.details })],
        warnings: [],
        lastSync: now,
        message: error.message || String(error)
      };
    }
    if (Object.keys(updates).length) ZotBindConfig.setStatuses(updates);
  },

  _statusSyncing(bindings) {
    let updates = {};
    for (let binding of bindings) {
      updates[binding.bindingID] = {
        state: binding.lifecycleState === "pendingCleanup" ? "Action required" : (this._active(binding) ? "Syncing" : "Paused"),
        syncing: this._active(binding),
        enabled: binding.enabled,
        lifecycleState: binding.lifecycleState
      };
    }
    ZotBindConfig.setStatuses(updates);
  },

  _recordIdentity(record) {
    return ZotBindCore.identityKey(record.itemLibraryID, record.itemKey);
  },

  _findOwnershipRecords(manifest, bindingID, identity) {
    let found = [];
    for (let [filename, record] of Object.entries(manifest.links)) {
      if (this._recordIdentity(record) !== identity) continue;
      if (record.bindings.some(owner => owner.bindingID === bindingID)) found.push({ filename, record });
    }
    return found;
  },

  _issueForBindings(issueMap, bindings, issue) {
    for (let owner of bindings) {
      if (!issueMap.has(owner.bindingID)) issueMap.set(owner.bindingID, []);
      issueMap.get(owner.bindingID).push({ ...issue, bindingID: owner.bindingID });
    }
  },

  async reconcileDestination(destinationPath, options = {}) {
    Zotero.debug("ZotBind reconciliation requested for " + destinationPath);
    await ZotBindFilesystem.assertDestination(destinationPath);
    await this.recover(destinationPath);

    let bindings = options.bindings || this._bindingsAt(destinationPath);
    if (!bindings.length) return { state: "Synced", linked: 0, errors: [] };
    if (!options.bindings) {
      let missing = bindings.filter(binding => this._active(binding) &&
        !ZotBindZoteroAdapter.getCollection(binding.libraryID, binding.collectionKey));
      for (let binding of missing) {
        ZotBindConfig.markCollectionDeleted(binding.libraryID, binding.collectionKey);
        setTimeout(() => ZotBindUI.promptPendingCleanup(binding.bindingID, Zotero.getMainWindow()), 0);
      }
      if (missing.length) bindings = this._bindingsAt(destinationPath);
    }
    this._statusSyncing(bindings);

    let oldManifest = await ZotBindFilesystem.readManifest(destinationPath, true) || ZotBindCore.emptyManifest();
    let activeBindings = bindings.filter(binding => this._active(binding));
    let activeIDs = new Set(activeBindings.map(binding => binding.bindingID));
    let frozenIDs = new Set(bindings.filter(binding => !this._active(binding)).map(binding => binding.bindingID));
    let resolved = [];
    let errorMap = new Map();
    let warningMap = new Map();
    let skippedMap = new Map();
    let sourceSignatures = {};
    let protectedOwnership = new Set();

    for (let binding of activeBindings) {
      let result = await ZotBindZoteroAdapter.resolveBinding(binding, oldManifest);
      sourceSignatures[binding.bindingID] = ZotBindZoteroAdapter.resolutionSignature(result);
      resolved.push(...result.records);
      skippedMap.set(binding.bindingID, result.skipped);
      errorMap.set(binding.bindingID, result.errors);
      warningMap.set(binding.bindingID, result.warnings);
      for (let ownership of result.protectedOwnership) protectedOwnership.add(ownership);
      if (result.collectionMissing && binding.lifecycleState === "active") {
        // Missing collections are frozen until the deletion decision is recorded.
        for (let [filename, record] of Object.entries(oldManifest.links)) {
          if (record.bindings.some(owner => owner.bindingID === binding.bindingID)) {
            protectedOwnership.add(ZotBindCore.ownershipKey(binding.bindingID, record.itemLibraryID, record.itemKey));
          }
        }
      }
    }

    let aggregated = ZotBindCore.aggregateDesired(resolved);
    for (let collision of aggregated.collisions) {
      let issue = ZotBindCore.makeIssue(
        "FILENAME_COLLISION",
        "Multiple Zotero items resolve to " + collision.filename,
        { filename: collision.filename, itemKeys: collision.records.map(record => record.itemKey) }
      );
      for (let record of collision.records) {
        this._issueForBindings(errorMap, record.bindings, issue);
        for (let owner of record.bindings) {
          protectedOwnership.add(ZotBindCore.ownershipKey(owner.bindingID, record.itemLibraryID, record.itemKey));
        }
        let identity = this._recordIdentity(record);
        for (let binding of activeBindings) {
          for (let previous of this._findOwnershipRecords(oldManifest, binding.bindingID, identity)) {
            protectedOwnership.add(ZotBindCore.ownershipKey(binding.bindingID, previous.record.itemLibraryID, previous.record.itemKey));
          }
        }
      }
    }

    let candidates = [];
    for (let [filename, desired] of aggregated.desired) {
      let oldAtPath = oldManifest.links[filename] || null;
      let actual = await ZotBindFilesystem.classify(ZotBindFilesystem.linkPath(destinationPath, filename));
      let issue = ZotBindCore.assessCandidate(desired, oldAtPath, actual, frozenIDs);
      if (issue) {
        this._issueForBindings(errorMap, desired.bindings, issue);
        for (let owner of desired.bindings) {
          protectedOwnership.add(ZotBindCore.ownershipKey(owner.bindingID, desired.itemLibraryID, desired.itemKey));
        }
        continue;
      }
      candidates.push({ filename, desired, oldAtPath });
    }

    let transactionID = ZotBindCore.uuid();
    let operations = [];
    for (let candidate of candidates) {
      operations.push({
        operationID: ZotBindCore.uuid(),
        type: "upsert",
        filename: candidate.filename,
        oldTarget: candidate.oldAtPath && candidate.oldAtPath.target || null,
        newTarget: candidate.desired.target,
        state: "planned"
      });
    }
    for (let [filename, record] of Object.entries(oldManifest.links)) {
      if (record.bindings.some(owner => activeIDs.has(owner.bindingID))) {
        operations.push({
          operationID: ZotBindCore.uuid(),
          type: "remove",
          filename,
          oldTarget: record.target,
          newTarget: null,
          state: "planned"
        });
      }
    }
    let journal = {
      schemaVersion: 1,
      generator: "zotbind",
      transactionID,
      destinationID: oldManifest.destinationID,
      startedAt: new Date().toISOString(),
      newGeneration: oldManifest.generation + 1,
      oldManifest: ZotBindCore.clone(oldManifest),
      newManifest: null,
      operations
    };
    await ZotBindFilesystem.writeJournal(destinationPath, journal);

    let successfulCandidates = [];
    let fatalRollback = null;
    for (let candidate of candidates) {
      let operation = operations.find(value => value.type === "upsert" && value.filename === candidate.filename);
      operation.state = "applying";
      await ZotBindFilesystem.writeJournal(destinationPath, journal);
      let linkPath = ZotBindFilesystem.linkPath(destinationPath, candidate.filename);
      try {
        if (!(await ZotBindFilesystem.sourceIsUsable(candidate.desired.target))) {
          throw ZotBindCore.codedError("PDF_NOT_LOCAL", "PDF became unavailable during synchronization: " + candidate.desired.target);
        }
        let actual = await ZotBindFilesystem.classify(linkPath);
        if (candidate.oldAtPath) {
          if (actual.type === "none") {
            await ZotBindFilesystem.createSymlink(candidate.desired.target, linkPath);
          }
          else if (actual.type === "symlink" && actual.target && ZotBindFilesystem.pathsEqual(actual.target, candidate.desired.target)) {
            // Already correct.
          }
          else if (actual.type === "symlink") {
            await ZotBindFilesystem.replaceManagedSymlink(linkPath, candidate.oldAtPath.target, candidate.desired.target);
          }
          else {
            throw ZotBindCore.codedError("UNMANAGED_PATH_CONFLICT", "Destination changed during synchronization: " + candidate.filename);
          }
        }
        else {
          if (actual.type !== "none") {
            throw ZotBindCore.codedError("UNMANAGED_PATH_CONFLICT", "Destination changed during synchronization: " + candidate.filename);
          }
          await ZotBindFilesystem.createSymlink(candidate.desired.target, linkPath);
        }
        let verified = await ZotBindFilesystem.classify(linkPath);
        if (verified.type !== "symlink" || !verified.target || !ZotBindFilesystem.pathsEqual(verified.target, candidate.desired.target) || !(await ZotBindFilesystem.sourceIsUsable(linkPath))) {
          throw ZotBindCore.codedError("MANAGED_LINK_TARGET_INVALID", "Link verification failed: " + candidate.filename);
        }
        operation.state = "done";
        successfulCandidates.push(candidate);
      }
      catch (error) {
        operation.state = "failed";
        operation.error = { code: error.code || "SYNC_FAILED", message: error.message || String(error) };
        // A failed upsert must not leave a transaction-created link outside
        // the committed manifest. Restore the previous state immediately.
        try {
          let actualAfterFailure = await ZotBindFilesystem.classify(linkPath);
          if (candidate.oldAtPath) {
            let isOld = actualAfterFailure.type === "symlink" && actualAfterFailure.target &&
              ZotBindFilesystem.pathsEqual(actualAfterFailure.target, candidate.oldAtPath.target);
            if (!isOld) {
              if (actualAfterFailure.type === "symlink" && actualAfterFailure.target &&
                  ZotBindFilesystem.pathsEqual(actualAfterFailure.target, candidate.desired.target)) {
                await ZotBindFilesystem.removeSymlink(linkPath, candidate.desired.target);
              }
              else if (actualAfterFailure.type !== "none") {
                throw ZotBindCore.codedError("TRANSACTION_ROLLBACK_FAILED", "The failed link changed unexpectedly: " + candidate.filename);
              }
              if (!(await ZotBindFilesystem.sourceIsUsable(candidate.oldAtPath.target))) {
                throw ZotBindCore.codedError("TRANSACTION_ROLLBACK_FAILED", "The previous PDF target cannot be restored: " + candidate.filename);
              }
              await ZotBindFilesystem.createSymlink(candidate.oldAtPath.target, linkPath);
            }
          }
          else if (actualAfterFailure.type === "symlink" && actualAfterFailure.target &&
              ZotBindFilesystem.pathsEqual(actualAfterFailure.target, candidate.desired.target)) {
            await ZotBindFilesystem.removeSymlink(linkPath, candidate.desired.target);
          }
          else if (actualAfterFailure.type !== "none") {
            throw ZotBindCore.codedError("TRANSACTION_ROLLBACK_FAILED", "The failed new path is ambiguous: " + candidate.filename);
          }
          delete error.rollbackError;
        }
        catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
        this._issueForBindings(errorMap, candidate.desired.bindings, operation.error);
        for (let owner of candidate.desired.bindings) {
          protectedOwnership.add(ZotBindCore.ownershipKey(owner.bindingID, candidate.desired.itemLibraryID, candidate.desired.itemKey));
        }
        if (error.rollbackError) {
          fatalRollback = ZotBindCore.codedError("TRANSACTION_ROLLBACK_FAILED", "A link replacement could not be rolled back", String(error.rollbackError));
          break;
        }
      }
      await ZotBindFilesystem.writeJournal(destinationPath, journal);
    }
    if (fatalRollback) throw fatalRollback;

    // Strip active ownership except where an error requires the previous state to remain.
    let nextManifest = ZotBindCore.buildOwnershipState(
      oldManifest,
      activeIDs,
      protectedOwnership,
      successfulCandidates.map(candidate => candidate.desired)
    );

    // New links are in place. Only now remove obsolete links whose ownership is empty.
    for (let [filename, record] of Object.entries(nextManifest.links)) {
      if (record.bindings.length) continue;
      let operation = operations.find(value => value.type === "remove" && value.filename === filename);
      if (!operation) {
        operation = { operationID: ZotBindCore.uuid(), type: "remove", filename, oldTarget: record.target, newTarget: null, state: "planned" };
        operations.push(operation);
        await ZotBindFilesystem.writeJournal(destinationPath, journal);
      }
      operation.state = "applying";
      await ZotBindFilesystem.writeJournal(destinationPath, journal);
      try {
        let linkPath = ZotBindFilesystem.linkPath(destinationPath, filename);
        let actual = await ZotBindFilesystem.classify(linkPath);
        if (actual.type === "none") {
          // Already absent.
        }
        else if (actual.type === "symlink" && actual.target && ZotBindFilesystem.pathsEqual(actual.target, record.target)) {
          await ZotBindFilesystem.removeSymlink(linkPath, record.target);
        }
        else {
          throw ZotBindCore.codedError("MANAGED_LINK_TARGET_INVALID", "Refusing stale-link cleanup because ownership cannot be revalidated: " + filename);
        }
        operation.state = "done";
        delete nextManifest.links[filename];
      }
      catch (error) {
        operation.state = "failed";
        operation.error = { code: error.code || "SYNC_FAILED", message: error.message || String(error) };
        // Retain the old record when physical cleanup failed.
        nextManifest.links[filename] = ZotBindCore.clone(oldManifest.links[filename] || record);
        let owners = oldManifest.links[filename] && oldManifest.links[filename].bindings || [];
        this._issueForBindings(errorMap, owners, operation.error);
      }
      await ZotBindFilesystem.writeJournal(destinationPath, journal);
    }

    nextManifest.generation = oldManifest.generation + 1;
    nextManifest.lastTransactionID = transactionID;
    nextManifest.bindingFingerprint = ZotBindCore.bindingFingerprint(bindings);
    nextManifest.sourceSignatures = sourceSignatures;
    nextManifest.updatedAt = new Date().toISOString();
    journal.newManifest = ZotBindCore.clone(nextManifest);
    await ZotBindFilesystem.writeJournal(destinationPath, journal);
    await ZotBindFilesystem.writeManifest(destinationPath, nextManifest);
    let committed = await ZotBindFilesystem.readManifest(destinationPath, false);
    if (committed.generation !== nextManifest.generation || committed.lastTransactionID !== transactionID) {
      throw ZotBindCore.codedError("MANIFEST_COMMIT_FAILED", "The committed manifest could not be verified");
    }
    await ZotBindFilesystem.removeJournal(destinationPath);

    let now = new Date().toISOString();
    let updates = {};
    for (let binding of bindings) {
      let errors = errorMap.get(binding.bindingID) || [];
      let warnings = warningMap.get(binding.bindingID) || [];
      let linked = Object.values(nextManifest.links).filter(record => record.bindings.some(owner => owner.bindingID === binding.bindingID)).length;
      let lifecycleState = binding.lifecycleState || "active";
      let state = lifecycleState === "pendingCleanup" || lifecycleState === "pendingDestinationChange"
        ? "Action required"
        : errors.length ? "Error" : warnings.length ? "Warning" : binding.enabled === false ? "Paused" : "Synced";
      updates[binding.bindingID] = {
        state,
        syncing: false,
        enabled: binding.enabled,
        lifecycleState,
        linked,
        skipped: skippedMap.get(binding.bindingID) || 0,
        errors,
        warnings,
        lastSync: now,
        lastSuccess: state === "Synced" ? now : ZotBindConfig.getStatus(binding.bindingID).lastSuccess,
        message: errors[0] && errors[0].message || warnings[0] && warnings[0].message ||
          (state === "Paused" ? "Synchronization is paused; existing links are frozen." : state === "Synced" ? linked + " linked" : "User action is required.")
      };
    }
    ZotBindConfig.setStatuses(updates);
    let allErrors = Array.from(errorMap.values()).flat();
    return { state: allErrors.length ? "Error" : "Synced", linked: Object.keys(nextManifest.links).length, errors: allErrors, manifest: nextManifest };
  },

  async recover(destinationPath) {
    let journal = await ZotBindFilesystem.readJournal(destinationPath);
    if (!journal) return false;
    if (!journal.oldManifest || !Array.isArray(journal.operations) || !journal.transactionID) {
      throw ZotBindCore.codedError("TRANSACTION_CORRUPT", "Interrupted transaction journal is incomplete");
    }
    let current = null;
    try { current = await ZotBindFilesystem.readManifest(destinationPath, true); }
    catch (_) {}
    if (current && current.generation === journal.newGeneration && current.lastTransactionID === journal.transactionID) {
      await ZotBindFilesystem.removeJournal(destinationPath);
      return true;
    }

    for (let operation of [...journal.operations].reverse()) {
      if (operation.state === "planned") continue;
      let path = ZotBindFilesystem.linkPath(destinationPath, operation.filename);
      let actual = await ZotBindFilesystem.classify(path);
      let oldRecord = journal.oldManifest.links[operation.filename] || null;
      if (operation.type === "upsert") {
        if (oldRecord) {
          if (actual.type === "symlink" && actual.target && ZotBindFilesystem.pathsEqual(actual.target, oldRecord.target)) continue;
          if (actual.type === "symlink" && actual.target && ZotBindFilesystem.pathsEqual(actual.target, operation.newTarget)) {
            await ZotBindFilesystem.removeSymlink(path, operation.newTarget);
            if (!(await ZotBindFilesystem.sourceIsUsable(oldRecord.target))) {
              throw ZotBindCore.codedError("TRANSACTION_RECOVERY_REQUIRED", "Cannot restore the previous link target: " + operation.filename);
            }
            await ZotBindFilesystem.createSymlink(oldRecord.target, path);
          }
          else if (actual.type === "none") {
            if (!(await ZotBindFilesystem.sourceIsUsable(oldRecord.target))) {
              throw ZotBindCore.codedError("TRANSACTION_RECOVERY_REQUIRED", "Cannot restore the missing previous link: " + operation.filename);
            }
            await ZotBindFilesystem.createSymlink(oldRecord.target, path);
          }
          else {
            throw ZotBindCore.codedError("TRANSACTION_RECOVERY_REQUIRED", "Ownership is ambiguous while recovering " + operation.filename);
          }
        }
        else {
          if (actual.type === "none") continue;
          if (actual.type === "symlink" && actual.target && ZotBindFilesystem.pathsEqual(actual.target, operation.newTarget)) {
            await ZotBindFilesystem.removeSymlink(path, operation.newTarget);
          }
          else {
            throw ZotBindCore.codedError("TRANSACTION_RECOVERY_REQUIRED", "Ownership is ambiguous while recovering " + operation.filename);
          }
        }
      }
      else if (operation.type === "remove" && oldRecord) {
        if (actual.type === "symlink" && actual.target && ZotBindFilesystem.pathsEqual(actual.target, oldRecord.target)) continue;
        if (actual.type !== "none") {
          throw ZotBindCore.codedError("TRANSACTION_RECOVERY_REQUIRED", "Cannot restore over an existing object: " + operation.filename);
        }
        if (!(await ZotBindFilesystem.sourceIsUsable(oldRecord.target))) {
          throw ZotBindCore.codedError("TRANSACTION_RECOVERY_REQUIRED", "Cannot restore the previous target: " + operation.filename);
        }
        await ZotBindFilesystem.createSymlink(oldRecord.target, path);
      }
    }
    await ZotBindFilesystem.writeManifest(destinationPath, journal.oldManifest);
    await ZotBindFilesystem.removeJournal(destinationPath);
    return true;
  },

  /** Remove one binding's ownership from one destination. */
  async detachAtDestination(binding, destinationPath, cleanup) {
    await ZotBindFilesystem.assertDestination(destinationPath);
    await this.recover(destinationPath);
    let manifest = await ZotBindFilesystem.readManifest(destinationPath, true);
    if (!manifest) return;
    let next = ZotBindCore.clone(manifest);
    let operations = [];
    for (let [filename, record] of Object.entries(next.links)) {
      let hadOwner = record.bindings.some(owner => owner.bindingID === binding.bindingID);
      if (!hadOwner) continue;
      record.bindings = record.bindings.filter(owner => owner.bindingID !== binding.bindingID);
      if (!record.bindings.length) {
        if (cleanup) operations.push({ operationID: ZotBindCore.uuid(), type: "remove", filename, oldTarget: record.target, newTarget: null, state: "planned" });
        else delete next.links[filename];
      }
    }
    let transactionID = ZotBindCore.uuid();
    let journal = {
      schemaVersion: 1,
      generator: "zotbind",
      transactionID,
      destinationID: manifest.destinationID,
      startedAt: new Date().toISOString(),
      newGeneration: manifest.generation + 1,
      oldManifest: ZotBindCore.clone(manifest),
      newManifest: null,
      operations
    };
    await ZotBindFilesystem.writeJournal(destinationPath, journal);
    for (let operation of operations) {
      operation.state = "applying";
      await ZotBindFilesystem.writeJournal(destinationPath, journal);
      let oldRecord = manifest.links[operation.filename];
      try {
        await ZotBindFilesystem.removeSymlink(
          ZotBindFilesystem.linkPath(destinationPath, operation.filename),
          oldRecord.target
        );
        delete next.links[operation.filename];
        operation.state = "done";
      }
      catch (error) {
        operation.state = "failed";
        operation.error = { code: error.code || "CLEANUP_FAILED", message: error.message || String(error) };
        await ZotBindFilesystem.writeJournal(destinationPath, journal);
        throw error;
      }
    }
    next.generation = manifest.generation + 1;
    next.lastTransactionID = transactionID;
    next.updatedAt = new Date().toISOString();
    next.bindingFingerprint = ZotBindCore.bindingFingerprint(this._bindingsAt(destinationPath).filter(value => value.bindingID !== binding.bindingID));
    journal.newManifest = ZotBindCore.clone(next);
    await ZotBindFilesystem.writeJournal(destinationPath, journal);
    await ZotBindFilesystem.writeManifest(destinationPath, next);
    await ZotBindFilesystem.removeJournal(destinationPath);
  },

  async shutdown() {
    this.stopping = true;
    let running = [];
    for (let job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      if (job.retryTimer) clearTimeout(job.retryTimer);
      if (job.running) {
        running.push(new Promise(resolve => {
          let check = () => job.running ? setTimeout(check, 50) : resolve();
          check();
        }));
      }
      for (let waiter of job.waiters.splice(0)) waiter.resolve(null);
    }
    if (running.length) {
      await Promise.race([
        Promise.allSettled(running),
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    }
  }
};
