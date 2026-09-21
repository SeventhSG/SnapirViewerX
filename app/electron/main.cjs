/**
 * Electron main process.
 *
 * There is no backend. The scan is read off the disk here, handed to the
 * renderer once, and everything after that - parsing, rendering, selection,
 * measurement, export - happens in that one process. Main's whole job is the
 * window, the file dialogs, the two small JSON stores, and the updater.
 */
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const DEV = process.env.SNAPIR_DEV === "1";
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

// Windows groups taskbar entries by this id, and uses it to find the icon.
if (WIN) app.setAppUserModelId("com.snapirdesign.viewerx");

let win = null;
/** A file the shell asked us to open before the window was ready to hear it. */
let queuedOpen = null;

/* ------------------------------------------------------------------ stores
   Two files under userData. Small, human-readable, and losing either one
   costs the operator a settings screen, not a scan. Both fail soft: a
   corrupt file reads as empty rather than stopping the app from starting. */

const storePath = (name) => path.join(app.getPath("userData"), name);

function readStore(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(storePath(name), "utf8"));
  } catch {
    return fallback;
  }
}

function writeStore(name, value) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(storePath(name), JSON.stringify(value, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error(`[store] could not write ${name}:`, e);
    return false;
  }
}

/* ------------------------------------------------------------------ window */

function createWindow() {
  win = new BrowserWindow({
    title: "Snapir Viewer X",
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#F6F6F3",
    icon: WIN
      ? path.join(__dirname, "..", "buildResources", "icon.ico")
      : path.join(__dirname, "..", "buildResources", "icon.png"),
    // Windows gets the overlaid caption buttons the page draws around. macOS
    // gets its inset traffic lights. Linux keeps its own decorations, because
    // a frameless window there leaves the operator with no way to close it.
    titleBarStyle: WIN || MAC ? (MAC ? "hiddenInset" : "hidden") : "default",
    ...(WIN
      ? { titleBarOverlay: { color: "#FBFBF9", symbolColor: "#5A5A61", height: 40 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const reveal = () => {
    if (!win || win.isDestroyed() || win.isVisible()) return;
    win.show();
    win.focus();
  };
  win.once("ready-to-show", reveal);
  // If the renderer never reports ready, show the window anyway. An invisible
  // process still holds the single-instance lock, so the app would look dead
  // and clicking the shortcut would do nothing at all.
  setTimeout(reveal, 2500);

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    reveal();
    dialog.showErrorBox(
      "Snapir Viewer could not load",
      `The interface failed to load.\n\n${desc} (${code})\n${url}`,
    );
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    // A point cloud is the one thing in this app big enough to run the
    // renderer out of memory, so say which reason it was rather than a
    // generic crash box.
    dialog.showErrorBox(
      "Snapir Viewer stopped responding",
      details.reason === "oom"
        ? "The interface ran out of memory. The scan is larger than this "
          + "machine can hold. Try a decimated export from the scanning app."
        : `The interface process ended: ${details.reason}`,
    );
  });
  win.webContents.on("console-message", (_e, _level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (DEV) {
    win.loadURL("http://localhost:5174");
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

/* ---------------------------------------------------------- opening a file
   Double-clicking a .svxp or a .ply has to reach the renderer, which may not
   exist yet. Anything that arrives early is parked and replayed on ready. */

const OPENABLE = /\.(svxp|ply)$/i;

function pickOpenable(argv) {
  return argv.slice(1).find((a) => OPENABLE.test(a) && fs.existsSync(a)) || null;
}

function deliverOpen(file) {
  if (!file) return;
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isLoading()) {
    win.webContents.send("open-file", file);
  } else {
    queuedOpen = file;
  }
}

ipcMain.handle("take-queued-open", async () => {
  const f = queuedOpen;
  queuedOpen = null;
  return f;
});

/* -------------------------------------------------------------- file plumbing */

ipcMain.handle("pick-scan", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Open a scan",
    filters: [
      { name: "Scans and projects", extensions: ["ply", "svxp"] },
      { name: "Point cloud", extensions: ["ply"] },
      { name: "Snapir Viewer X project", extensions: ["svxp"] },
    ],
    properties: ["openFile"],
  });
  return r.canceled ? null : r.filePaths[0];
});

// Read is deliberately one shot rather than a stream. The parser needs the
// whole header before it can size anything, and a scan this app will open
// fits in memory by definition - it has to, to be drawn.
ipcMain.handle("read-file", async (_e, target) => {
  try {
    const stat = await fsp.stat(target);
    const buf = await fsp.readFile(target);
    // Hand over the exact bytes. Node may return a Buffer that is a view into
    // a larger pool, and slicing by byteOffset is what keeps a 400 MB scan
    // from arriving as a 512 MB one.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { ok: true, data: ab, size: stat.size, name: path.basename(target) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("save-file", async (_e, { suggested, data, filters }) => {
  const r = await dialog.showSaveDialog(win, {
    title: "Export",
    defaultPath: suggested,
    filters: filters || [{ name: "All files", extensions: ["*"] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    await fsp.writeFile(r.filePath, Buffer.from(data));
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("reveal", async (_e, target) => {
  if (target) shell.showItemInFolder(target);
});

ipcMain.handle("path-exists", async (_e, target) => {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
});

// The Windows caption buttons live outside the page, so the theme has to be
// pushed to them separately or they stay light on a dark window.
ipcMain.handle("set-theme", async (_e, dark) => {
  if (!win || win.isDestroyed()) return;
  nativeTheme.themeSource = dark ? "dark" : "light";
  win.setBackgroundColor(dark ? "#141416" : "#F6F6F3");
  try {
    win.setTitleBarOverlay({
      color: dark ? "#181819" : "#FBFBF9",
      symbolColor: dark ? "#A6A5A0" : "#5A5A61",
      height: 40,
    });
  } catch { /* not a platform with an overlay to set */ }
});

ipcMain.handle("store-get", async (_e, name) =>
  readStore(name, name === "recents.json" ? [] : {}));
ipcMain.handle("store-set", async (_e, name, value) => writeStore(name, value));

ipcMain.handle("app-info", async () => ({
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
}));

/* -------------------------------------------------------------- updates
   Checks GitHub Releases for a newer build. A found update downloads in the
   background and installs itself the moment it lands - silent, no prompt, so
   it never interrupts a session. A failed check (offline, no update, no
   release yet) is not an error: the app just keeps running what it has. */

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.on("error", (err) => console.error("[update] error:", err));
autoUpdater.on("update-downloaded", () => autoUpdater.quitAndInstall(true, true));

function checkForUpdates() {
  if (!app.isPackaged) return;  // dev builds have no update feed to check
  autoUpdater.checkForUpdates().catch((err) =>
    console.error("[update] check failed:", err));
}

/* ---------------------------------------------------------------- lifecycle */

// One window per machine. A second launch focuses the first and hands it
// whatever file was double-clicked, rather than starting a rival app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    deliverOpen(pickOpenable(argv));
  });

  // macOS delivers the file this way rather than on argv.
  app.on("open-file", (e, file) => {
    e.preventDefault();
    deliverOpen(file);
  });

  app.whenReady().then(() => {
    queuedOpen = pickOpenable(process.argv);
    createWindow();
    checkForUpdates();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (!MAC) app.quit();
});
