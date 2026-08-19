# ZotBind

ZotBind is a Zotero 9 add-on that binds a collection to a local papers directory and keeps symbolic links to the collection's primary PDFs synchronized. Link names use Zotero's native citation key and fall back to the item key.

## Install

1. Open Zotero 9.
2. Choose **Tools → Plugins**.
3. Open the gear menu and choose **Install Plugin From File…**.
4. Select `dist/zotbind-[version].xpi` and restart Zotero if requested.

## Usage

Right-click a collection and choose **ZotBind → Set papers directory…**, or open the ZotBind pane in Zotero Preferences.

> [!NOTE]
> The author has only tested this add-on on macOS. They are not sure whether it works on Windows or Linux. On Windows, symbolic links require Developer Mode or a process account with symbolic-link permission. ZotBind reports an error rather than copying files when symlink creation is unavailable.

## Safety and data access

ZotBind reads collection metadata and local attachment paths. It writes a manifest, a crash-recovery journal during synchronization, and manifest-owned symbolic links only in directories selected by the user. It does not read PDF contents, modify Zotero attachments, overwrite ordinary files, or delete entries whose ownership cannot be established.

## Build and test

```sh
npm test
npm run check
npm run build
```

`npm run build` creates a versioned XPI, its SHA-256 checksum, and `updates.json`. Before publishing, run the operating-system and Zotero-version release matrix in `zotbind-spec.md`; the included artifact declares compatibility only with the tested Zotero 9.0 range.
