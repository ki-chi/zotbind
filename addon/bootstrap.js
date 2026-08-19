/* ZotBind bootstrapped add-on entry point for Zotero 9+. */

var ZotBindBootstrap = {
  id: null,
  rootURI: null,
  started: false,
  scripts: [
    "content/core.js",
    "content/config.js",
    "content/filesystem.js",
    "content/zotero-adapter.js",
    "content/sync.js",
    "content/ui.js",
    "content/runtime.js"
  ]
};

async function startup({ id, version, rootURI }) {
  if (ZotBindBootstrap.started) return;
  ZotBindBootstrap.started = true;
  ZotBindBootstrap.id = id;
  ZotBindBootstrap.rootURI = rootURI;

  try {
    await Zotero.initializationPromise;
    for (let script of ZotBindBootstrap.scripts) {
      Services.scriptloader.loadSubScript(rootURI + script, globalThis);
    }
    await ZotBindRuntime.start({ id, version, rootURI });
    for (let window of Zotero.getMainWindows()) {
      await ZotBindRuntime.onMainWindowLoad(window);
    }
  }
  catch (error) {
    Zotero.logError(error);
    ZotBindBootstrap.started = false;
    throw error;
  }
}

async function shutdown() {
  if (!ZotBindBootstrap.started) return;
  try {
    if (typeof ZotBindRuntime !== "undefined") {
      await ZotBindRuntime.stop();
    }
  }
  catch (error) {
    Zotero.logError(error);
  }
  finally {
    ZotBindBootstrap.started = false;
  }
}

async function onMainWindowLoad({ window }) {
  if (ZotBindBootstrap.started && typeof ZotBindRuntime !== "undefined") {
    await ZotBindRuntime.onMainWindowLoad(window);
  }
}

async function onMainWindowUnload({ window }) {
  if (typeof ZotBindRuntime !== "undefined") {
    ZotBindRuntime.onMainWindowUnload(window);
  }
}

function install() {}

function uninstall() {
  // Deliberately preserve preferences, manifests, and links. Cleanup is an
  // explicit user action in Preferences because uninstall has no safe prompt.
}
