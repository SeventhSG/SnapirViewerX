/**
 * The one place that knows what the interface is running inside.
 *
 * `window.snapir` is the contract. The Electron preload implements it today;
 * an Android shell in a WebView and an iOS shell in a WKWebView implement the
 * same nine methods and nothing above this file changes. When no host has
 * injected it at all - a plain browser, or a mobile shell still being wired
 * up - the fallback below implements the same contract out of a file input,
 * a download link and localStorage, so the app still opens, still measures
 * and still exports.
 *
 * Everything here is async on purpose, including the parts a browser could
 * answer synchronously. A native bridge cannot, and having one shape means
 * the callers never find out which host they got.
 */

export type ShellKind = "electron" | "android" | "ios" | "web";

/** What a host has to provide. Nine methods, no more. */
export interface ShellBridge {
  pickScan(): Promise<string | null>;
  readFile(ref: string): Promise<ReadResult>;
  saveFile(opts: SaveRequest): Promise<SaveResult>;
  reveal(target: string): Promise<void>;
  pathExists(target: string): Promise<boolean>;
  setTheme(dark: boolean): Promise<void>;
  storeGet(name: string): Promise<unknown>;
  storeSet(name: string, value: unknown): Promise<boolean>;
  appInfo(): Promise<AppInfo>;
  takeQueuedOpen?(): Promise<string | null>;
  onOpenFile?(fn: (ref: string) => void): () => void;
}

export type ReadResult =
  | { ok: true; data: ArrayBuffer; size: number; name: string }
  | { ok: false; error: string };

export interface SaveRequest {
  suggested: string;
  data: Uint8Array;
  filters?: { name: string; extensions: string[] }[];
}

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; canceled?: true; error?: string };

export interface AppInfo {
  version: string;
  platform: string;
  electron?: string;
  chrome?: string;
}

/* ------------------------------------------------------------------ fallback
   No host. Everything a desktop shell does with paths, this does with File
   objects held in memory and handed back under a synthetic reference. The
   reference looks like a path to the rest of the app and never has to be one. */

const held = new Map<string, File>();
let heldSeq = 0;

/** Park a File - from a drop, or a picker - and get a reference back. */
export function holdFile(file: File): string {
  const ref = `mem:${++heldSeq}/${file.name}`;
  held.set(ref, file);
  return ref;
}

/** The display name for a reference, whichever kind it is. */
export function refName(ref: string): string {
  const held = ref.startsWith("mem:");
  const cut = ref.lastIndexOf(held ? "/" : ref.includes("\\") ? "\\" : "/");
  return cut >= 0 ? ref.slice(cut + 1) : ref;
}

/** True when the reference is a real file on a real disk we can point at. */
export function isRealPath(ref: string): boolean {
  return !ref.startsWith("mem:");
}

function browserBridge(): ShellBridge {
  return {
    async pickScan() {
      return new Promise<string | null>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".ply,.svxp";
        // A cancelled picker fires nothing in most browsers, so the element is
        // dropped on the next focus instead of leaking one per attempt.
        input.onchange = () => {
          const f = input.files?.[0];
          resolve(f ? holdFile(f) : null);
        };
        window.addEventListener("focus", () => setTimeout(() => resolve(null), 400),
          { once: true });
        input.click();
      });
    },

    async readFile(ref) {
      const f = held.get(ref);
      if (!f) return { ok: false, error: "That file is no longer open." };
      try {
        return { ok: true, data: await f.arrayBuffer(), size: f.size, name: f.name };
      } catch (e) {
        return { ok: false, error: String((e as Error).message || e) };
      }
    },

    async saveFile({ suggested, data }) {
      try {
        // A copy, because the Blob has to own bytes the caller may reuse, and
        // because a view into a larger buffer would otherwise write the lot.
        const blob = new Blob([data.slice()], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = suggested;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return { ok: true, path: suggested };
      } catch (e) {
        return { ok: false, error: String((e as Error).message || e) };
      }
    },

    // Nothing to reveal and no caption buttons to repaint. Both are no-ops
    // rather than errors: the caller should not have to ask which host it got.
    async reveal() { /* no file manager to hand off to */ },
    async setTheme() { /* the page already carries the theme */ },

    async pathExists(ref) { return held.has(ref); },

    async storeGet(name) {
      try {
        const raw = localStorage.getItem(`snapir:${name}`);
        return raw ? JSON.parse(raw) : (name === "recents.json" ? [] : {});
      } catch {
        return name === "recents.json" ? [] : {};
      }
    },

    async storeSet(name, value) {
      try {
        localStorage.setItem(`snapir:${name}`, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },

    async appInfo() {
      return { version: __APP_VERSION__, platform: "web" };
    },
  };
}

/* ---------------------------------------------------------------- selection */

const injected = (globalThis as unknown as { snapir?: ShellBridge }).snapir;

export const shell: ShellBridge = injected ?? browserBridge();

export const shellKind: ShellKind = (() => {
  if (!injected) return "web";
  const ua = navigator.userAgent;
  if (/Electron/i.test(ua)) return "electron";
  if (/Android/i.test(ua)) return "android";
  if (/iPad|iPhone|iPod/i.test(ua)) return "ios";
  // A host injected the bridge but does not say what it is in the user agent.
  // It is not a browser, and every non-browser host packages the same way, so
  // treat it as a desktop shell rather than guessing wrong about layout.
  return "electron";
})();

/** True where the window has no border of its own and the page draws one. */
export const drawsOwnTitlebar = shellKind === "electron";
