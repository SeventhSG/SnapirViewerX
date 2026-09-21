import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise, ArrowCounterClockwise, CornersOut, Cube, Export, FloppyDisk,
  FolderOpen, Ruler, Selection as SelectionIcon, Trash, X,
} from "@phosphor-icons/react";

import Viewport, { type RectNdc, type SelectMode, type Tool, type UpAxis,
  type ViewMode } from "./Viewport";
import {
  PointCloud, defaultMeasurementName, newMeasurementId, type Measurement,
} from "./cloud";
import { openScan, type LoadPhase } from "./load";
import { writePly } from "./ply";
import { holdFile, isRealPath, refName, shell, shellKind } from "./shell";
import { writeSvxp, type SvxpView } from "./svxp";
import { t, type Key, type Lang } from "./i18n";
import { UNITS, UNIT_LABEL, formatLength, formatWithUnit, type Unit } from "./units";

/* The real mark, traced from the logo. currentColor so it works anywhere. */
const MARK_D =
  "M27.48 17.73 L27.48 27.84 L12.77 42.73 L47.52 42.73 L67.38 22.87 L67.38 22.16 "
  + "L72.52 17.73 L100.00 44.86 L100.00 82.45 L92.55 82.45 L92.55 47.16 L72.52 27.84 "
  + "L53.19 47.16 L53.19 82.45 L45.74 82.45 L45.74 50.53 L7.45 50.53 L7.45 82.45 "
  + "L0.00 82.45 L0.00 44.86Z";

function Mark({ className = "mk" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true" fill="currentColor">
      <path fillRule="evenodd" d={MARK_D} />
    </svg>
  );
}

type Theme = "light" | "dark";
type Screen = "home" | "loading" | "work" | "settings";

interface Settings {
  lang: Lang;
  theme: Theme;
  displayUnit: Unit;
  /** What a fresh .ply is assumed to be measured in. */
  defaultSourceUnit: Unit | "auto";
  pointSize: number;
  attenuate: boolean;
  showStats: boolean;
  upAxis: UpAxis;
}

const DEFAULTS: Settings = {
  lang: "en",
  theme: "light",
  displayUnit: "m",
  defaultSourceUnit: "auto",
  pointSize: 2,
  attenuate: false,
  showStats: false,
  upAxis: "y",
};

interface Recent {
  ref: string;
  name: string;
  points: number;
  removed: number;
  measurements: number;
  openedAt: number;
  /** A small PNG as a data URL, captured when the scan was last put down. */
  thumb?: string;
}

const RECENT_LIMIT = 8;
const nf = new Intl.NumberFormat();

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const T = useCallback((k: Key) => t(settings.lang, k), [settings.lang]);

  const [screen, setScreen] = useState<Screen>("home");
  const [settingsTab, setSettingsTab] = useState<"units" | "display" | "about">("units");
  const [toast, setToast] = useState<
    { msg: string; bad?: boolean; action?: { label: string; run: () => void } } | null>(null);

  const [cloud, setCloud] = useState<PointCloud | null>(null);
  const [revision, setRevision] = useState(0);
  const [fitSignal, setFitSignal] = useState(0);
  const [tool, setTool] = useState<Tool>("orbit");
  const [view, setView] = useState<ViewMode>("outside");

  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [selectedMeasurement, setSelectedMeasurement] = useState<string | null>(null);
  const [pendingPoint, setPendingPoint] = useState<number | null>(null);

  const [phase, setPhase] = useState<LoadPhase>({ stage: "reading" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingName, setLoadingName] = useState("");
  const [openMillis, setOpenMillis] = useState(0);
  const [projectCreated, setProjectCreated] = useState<string | undefined>();

  const [recents, setRecents] = useState<Recent[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [appVersion, setAppVersion] = useState(__APP_VERSION__);
  const [rendererName, setRendererName] = useState("");

  const thumbnailHandle = useRef<(() => Promise<Uint8Array | null>) | null>(null);
  const dragDepth = useRef(0);

  /* ------------------------------------------------------------ persistence */

  useEffect(() => {
    let alive = true;
    (async () => {
      const [stored, recent, info] = await Promise.all([
        shell.storeGet("settings.json"),
        shell.storeGet("recents.json"),
        shell.appInfo(),
      ]);
      if (!alive) return;
      setSettings({ ...DEFAULTS, ...(stored as Partial<Settings> || {}) });
      setRecents(Array.isArray(recent) ? (recent as Recent[]) : []);
      setAppVersion(info.version || __APP_VERSION__);
      setSettingsLoaded(true);
    })();
    return () => { alive = false; };
  }, []);

  // Written back only after the first read has landed, or the defaults would
  // overwrite the operator's saved settings on every launch.
  useEffect(() => {
    if (!settingsLoaded) return;
    shell.storeSet("settings.json", settings);
  }, [settings, settingsLoaded]);

  const dark = settings.theme === "dark";
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.shell = shellKind;
    shell.setTheme(dark);
  }, [settings.theme, dark]);

  /* ----------------------------------------------------------------- toast */

  const say = useCallback((msg: string, opts?: {
    bad?: boolean; action?: { label: string; run: () => void };
  }) => {
    setToast({ msg, bad: opts?.bad, action: opts?.action });
  }, []);

  useEffect(() => {
    if (!toast) return;
    // An offer to undo is worth reading twice as long as a confirmation.
    const ms = toast.action ? 7000 : toast.bad ? 6000 : 3000;
    const id = setTimeout(() => setToast(null), ms);
    return () => clearTimeout(id);
  }, [toast]);

  /* ------------------------------------------------------------- recents */

  const saveRecents = useCallback((next: Recent[]) => {
    setRecents(next);
    shell.storeSet("recents.json", next);
  }, []);

  /** Put the open scan into the recent list, with a picture of how it was left. */
  const remember = useCallback(async (c: PointCloud, ms: Measurement[]) => {
    let thumb: string | undefined;
    try {
      const png = await thumbnailHandle.current?.();
      if (png) {
        let binary = "";
        for (const b of png) binary += String.fromCharCode(b);
        thumb = `data:image/png;base64,${btoa(binary)}`;
      }
    } catch { /* a recent entry without a picture is still a recent entry */ }

    const entry: Recent = {
      ref: c.source.ref,
      name: c.source.name,
      points: c.visibleCount,
      removed: c.removedCount,
      measurements: ms.length,
      openedAt: Date.now(),
      thumb,
    };
    setRecents((prev) => {
      // A dropped file lives in memory and its reference dies with the window,
      // so it is never worth listing as something to come back to.
      const keep = isRealPath(entry.ref);
      const next = [
        ...(keep ? [entry] : []),
        ...prev.filter((r) => r.ref !== entry.ref),
      ].slice(0, RECENT_LIMIT);
      shell.storeSet("recents.json", next);
      return next;
    });
  }, []);

  /* -------------------------------------------------------------- opening */

  const open = useCallback(async (ref: string) => {
    setScreen("loading");
    setLoadError(null);
    setLoadingName(refName(ref));
    setPhase({ stage: "reading" });
    try {
      const result = await openScan(ref, settings.defaultSourceUnit, setPhase);
      setCloud(result.cloud);
      setRevision((r) => r + 1);
      setMeasurements(result.project?.measurements ?? []);
      setProjectCreated(result.project?.manifest.created);
      setSelectedMeasurement(null);
      setPendingPoint(null);
      setTool("orbit");
      setView("outside");
      setOpenMillis(result.millis);
      if (result.project?.view) {
        const v = result.project.view;
        setSettings((s) => ({
          ...s,
          displayUnit: v.displayUnit ?? s.displayUnit,
          pointSize: v.pointSize ?? s.pointSize,
        }));
      }
      setScreen("work");
    } catch (e) {
      setLoadError(String((e as Error).message || e));
    }
  }, [settings.defaultSourceUnit]);

  const pickAndOpen = useCallback(async () => {
    const ref = await shell.pickScan();
    if (ref) open(ref);
  }, [open]);

  // A .svxp or .ply double-clicked in the shell, whether the app was already
  // running or was started by the double-click itself.
  useEffect(() => {
    let alive = true;
    shell.takeQueuedOpen?.().then((f) => { if (alive && f) open(f); });
    const off = shell.onOpenFile?.((f) => open(f));
    return () => { alive = false; off?.(); };
  }, [open]);

  /* ------------------------------------------------------------ drag drop */

  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      dragDepth.current++;
      setDragOver(true);
    };
    const leave = (e: DragEvent) => {
      e.preventDefault();
      // Counted rather than toggled: dragging across a child element fires
      // leave on the parent, and a plain toggle flickers the whole overlay.
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragOver(false);
    };
    const move = (e: DragEvent) => { e.preventDefault(); };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      // Electron gives a real path on the File; a browser does not, and there
      // the bytes are held in memory under a synthetic reference instead.
      const path = (file as File & { path?: string }).path;
      open(path && isRealPath(path) ? path : holdFile(file));
    };
    window.addEventListener("dragenter", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", move);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", move);
      window.removeEventListener("drop", drop);
    };
  }, [open]);

  /* ---------------------------------------------------------------- edits */

  const touch = useCallback(() => setRevision((r) => r + 1), []);

  /** Changing tool abandons a half-finished measurement. Leaving it pending
   *  left the viewport asking for a second point while the Select tool was
   *  the one actually listening. */
  const chooseTool = useCallback((next: Tool) => {
    setTool(next);
    if (next !== "measure") setPendingPoint(null);
  }, []);

  const onRectSelect = useCallback((rect: RectNdc, mode: SelectMode, clip: Float32Array) => {
    if (!cloud) return;
    if (rect.x0 === rect.x1 && rect.y0 === rect.y1) {
      cloud.clearSelection();
      touch();
      return;
    }
    const n = cloud.selectByClipRect(clip, rect, mode);
    touch();
    if (cloud.selection === 0 && n === 0) return;
    say(`${T("selectedN")} ${nf.format(cloud.selection)}`);
  }, [cloud, say, T, touch]);

  const doDelete = useCallback(() => {
    if (!cloud) return;
    if (!cloud.selection) { say(T("nothingToDelete"), { bad: true }); return; }
    const n = cloud.deleteSelected();
    touch();
    say(`${T("deletedN")} ${nf.format(n)} ${T("points")}`, {
      action: { label: T("undo"), run: () => { cloud.undo(); touch(); setToast(null); } },
    });
  }, [cloud, say, T, touch]);

  const doKeep = useCallback(() => {
    if (!cloud) return;
    if (!cloud.selection) { say(T("nothingToDelete"), { bad: true }); return; }
    const n = cloud.keepSelected();
    touch();
    say(`${T("deletedN")} ${nf.format(n)} ${T("points")}`, {
      action: { label: T("undo"), run: () => { cloud.undo(); touch(); setToast(null); } },
    });
  }, [cloud, say, T, touch]);

  const doUndo = useCallback(() => {
    if (!cloud?.canUndo) return;
    const n = cloud.undo();
    touch();
    say(`${T("restoredN")} ${nf.format(n)} ${T("points")}`);
  }, [cloud, say, T, touch]);

  const doRedo = useCallback(() => {
    if (!cloud?.canRedo) return;
    const n = cloud.redo();
    touch();
    say(`${T("deletedN")} ${nf.format(n)} ${T("points")}`);
  }, [cloud, say, T, touch]);

  /* ---------------------------------------------------------- measurement */

  const onPickPoint = useCallback((index: number | null) => {
    if (!cloud) return;
    if (index == null) { say(T("nothingUnder"), { bad: true }); return; }
    if (pendingPoint == null) { setPendingPoint(index); return; }
    if (pendingPoint === index) { setPendingPoint(null); return; }

    const m: Measurement = {
      id: newMeasurementId(),
      a: pendingPoint,
      b: index,
      metres: cloud.distance(pendingPoint, index),
      name: defaultMeasurementName(measurements.length),
    };
    setMeasurements((prev) => [...prev, m]);
    setSelectedMeasurement(m.id);
    setPendingPoint(null);
    say(`${T("measurementAdded")}: ${formatWithUnit(m.metres, settings.displayUnit)}`);
  }, [cloud, pendingPoint, measurements.length, settings.displayUnit, say, T]);

  const removeMeasurement = useCallback((id: string) => {
    setMeasurements((prev) => prev.filter((m) => m.id !== id));
    setSelectedMeasurement((s) => (s === id ? null : s));
    say(T("measurementRemoved"));
  }, [say, T]);

  const renameMeasurement = useCallback((id: string, name: string) => {
    setMeasurements((prev) => prev.map((m) => (m.id === id ? { ...m, name } : m)));
  }, []);

  /* --------------------------------------------------------------- export */

  const viewState = useCallback((): SvxpView => ({
    displayUnit: settings.displayUnit,
    pointSize: settings.pointSize,
    background: settings.theme,
  }), [settings]);

  const saveProject = useCallback(async () => {
    if (!cloud) return;
    let thumbnail: Uint8Array | null = null;
    try { thumbnail = await thumbnailHandle.current?.() ?? null; } catch { /* optional */ }

    const data = writeSvxp(cloud, {
      measurements,
      view: viewState(),
      thumbnail,
      created: projectCreated,
      appVersion,
    });
    const r = await shell.saveFile({
      suggested: `${cloud.source.name}.svxp`,
      data,
      filters: [{ name: "Snapir Viewer X project", extensions: ["svxp"] }],
    });
    if (!r.ok) {
      if (!r.canceled) say(r.error || T("exportFailed"), { bad: true });
      return;
    }
    remember(cloud, measurements);
    say(`${T("exported")} ${refName(r.path)}`, {
      action: isRealPath(r.path)
        ? { label: T("showInFolder"), run: () => shell.reveal(r.path) }
        : undefined,
    });
  }, [cloud, measurements, viewState, projectCreated, appVersion, remember, say, T]);

  const exportPly = useCallback(async () => {
    if (!cloud) return;
    if (cloud.visibleCount === 0) { say(T("allGone"), { bad: true }); return; }
    const packed = cloud.compact();
    const data = writePly(packed.positions, packed.colors, packed.count, [
      `written by Snapir Viewer X ${appVersion}`,
      `source ${cloud.source.name}`,
      `units ${cloud.sourceUnit}`,
    ]);
    const r = await shell.saveFile({
      suggested: `${cloud.source.name}-cleaned.ply`,
      data,
      filters: [{ name: "Point cloud", extensions: ["ply"] }],
    });
    if (!r.ok) {
      if (!r.canceled) say(r.error || T("exportFailed"), { bad: true });
      return;
    }
    say(`${T("exported")} ${refName(r.path)}`, {
      action: isRealPath(r.path)
        ? { label: T("showInFolder"), run: () => shell.reveal(r.path) }
        : undefined,
    });
  }, [cloud, appVersion, say, T]);

  /* ------------------------------------------------------------- keyboard
     Every one of these is a shortcut for something already on screen, never
     the only way to reach it. Nothing here animates: a keyboard action should
     land before the key is back up.

     Declared after the actions it calls, because the dependency array is
     evaluated during render and a `const` named above its own declaration
     would throw before the first frame. */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
        || el.isContentEditable)) return;
      if (screen !== "work" || !cloud) return;

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if (mod && key === "y") { e.preventDefault(); doRedo(); return; }
      if (mod && key === "a") {
        e.preventDefault(); cloud.selectAll(); touch(); return;
      }
      if (mod && key === "i") {
        e.preventDefault(); cloud.invertSelection(); touch(); return;
      }
      if (mod && key === "s") { e.preventDefault(); saveProject(); return; }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault(); doDelete(); return;
      }
      if (e.key === "Escape") {
        if (pendingPoint != null) setPendingPoint(null);
        else { cloud.clearSelection(); touch(); }
        return;
      }
      if (key === "f") { setFitSignal((s) => s + 1); return; }
      if (e.key === "1") chooseTool("orbit");
      if (e.key === "2") chooseTool("select");
      if (e.key === "3") chooseTool("measure");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, cloud, doUndo, doRedo, doDelete, saveProject, pendingPoint, touch]);

  /* ---------------------------------------------------------------- views */

  const leaveWorkspace = useCallback(async () => {
    if (cloud) await remember(cloud, measurements);
    setScreen("home");
  }, [cloud, measurements, remember]);

  const extent = useMemo(
    () => cloud?.extent() ?? null,
    // The box is only re-measured when the cloud or the unit actually changed.
    [cloud, revision, settings.displayUnit],
  );

  return (
    <div className="app">
      <header className="titlebar">
        <Mark />
        <b>{T("appName")}</b>
        {cloud && screen === "work" && (
          <span className="crumb">/ {cloud.source.name}</span>
        )}
        <div className="right">
          <div className="lang" role="group" aria-label={T("language")}>
            {(["en", "tr"] as Lang[]).map((l) => (
              <button key={l} aria-pressed={settings.lang === l}
                onClick={() => setSettings((s) => ({ ...s, lang: l }))}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="seg quiet" role="group">
            <button aria-pressed={screen === "home"} onClick={leaveWorkspace}>
              {T("navHome")}
            </button>
            {cloud && (
              <button aria-pressed={screen === "work"} onClick={() => setScreen("work")}>
                {T("navWork")}
              </button>
            )}
            <button aria-pressed={screen === "settings"}
              onClick={() => setScreen("settings")}>
              {T("navSettings")}
            </button>
          </div>
        </div>
      </header>

      <main className="main">
        {screen === "home" && (
          <div className="screen" key="home">
            <div className="page">
              <section className="home">
                <div className="hero">
                  <Mark className="hero-mk" />
                  <div>
                    <h1>{T("appName")}</h1>
                    <p>{T("heroLead")} {T("heroSub")}</p>
                  </div>
                  <div className="homeacts">
                    <button className="btn" onClick={pickAndOpen}>
                      <FolderOpen size={16} weight="bold" />
                      {T("openScan")}
                    </button>
                  </div>
                </div>

                {recents.length === 0 ? (
                  <div className="empty">
                    <Mark />
                    <b>{T("noScans")}</b>
                    <p>{T("noScansHelp")}</p>
                    <button className="btn q" onClick={pickAndOpen}>
                      {T("openScan")}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="page-head">
                      <h2>{T("recent")}</h2>
                      <span className="num">{recents.length}</span>
                    </div>
                    <div className="cards">
                      {recents.map((r) => (
                        <RecentCard key={r.ref} recent={r} T={T}
                          onOpen={() => open(r.ref)}
                          onForget={() =>
                            saveRecents(recents.filter((x) => x.ref !== r.ref))} />
                      ))}
                    </div>
                  </>
                )}
              </section>
            </div>
          </div>
        )}

        {screen === "loading" && (
          <div className="screen" key="loading">
            <div className="loading">
              <div className="in">
                <Mark />
                {loadError ? (
                  <>
                    <b>{T("openFailed")}</b>
                    <p className="err">{loadError}</p>
                    <button className="btn q" onClick={() => setScreen("home")}>
                      {T("back")}
                    </button>
                  </>
                ) : (
                  <>
                    <b>
                      {phase.stage === "reading" ? T("reading") : T("parsing")}
                    </b>
                    <div className="track">
                      <i style={{
                        width: phase.stage === "parsing"
                          ? `${Math.round(phase.fraction * 100)}%`
                          : "6%",
                      }} />
                    </div>
                    <small>{loadingName}</small>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {screen === "work" && cloud && (
          <div className="ws" key="work">
            <div className="vp">
              <Viewport
                cloud={cloud}
                revision={revision}
                tool={tool}
                view={view}
                pointSize={settings.pointSize}
                attenuate={settings.attenuate}
                showStats={settings.showStats}
                dark={dark}
                upAxis={settings.upAxis}
                measurements={measurements}
                selectedMeasurement={selectedMeasurement}
                displayUnit={settings.displayUnit}
                pendingPoint={pendingPoint}
                fitSignal={fitSignal}
                onRectSelect={onRectSelect}
                onPickPoint={onPickPoint}
                onPickMeasurement={setSelectedMeasurement}
                thumbnailHandle={thumbnailHandle}
              />

              <div className="rail" role="group">
                <button aria-pressed={tool === "orbit"} onClick={() => chooseTool("orbit")}>
                  <Cube size={15} weight="bold" /> {T("toolOrbit")}
                </button>
                <button aria-pressed={tool === "select"} onClick={() => chooseTool("select")}>
                  <SelectionIcon size={15} weight="bold" /> {T("toolSelect")}
                </button>
                <button aria-pressed={tool === "measure"}
                  onClick={() => chooseTool("measure")}>
                  <Ruler size={15} weight="bold" /> {T("toolMeasure")}
                </button>
              </div>

              <div className="hud">
                {nf.format(cloud.visibleCount)} {T("points")}
                {cloud.removedCount > 0
                  && `  ·  ${nf.format(cloud.removedCount)} ${T("removed")}`}
              </div>

              <div className="overlay">
                <p className="hint">
                  {pendingPoint != null
                    ? T("pickSecond")
                    : view === "inside" ? T("insideHint")
                      : tool === "select" ? T("toolSelectHint")
                        : tool === "measure" ? T("toolMeasureHint")
                          : T("toolOrbitHint")}
                </p>
                <div className="bar">
                  <div className="seg quiet vptoggle" role="group">
                    <button aria-pressed={view === "outside"}
                      onClick={() => setView("outside")}>
                      {T("viewOutside")}
                    </button>
                    <button aria-pressed={view === "inside"}
                      onClick={() => setView("inside")}>
                      {T("viewInside")}
                    </button>
                  </div>
                  <div className="acts">
                    <button className="btn q sm" onClick={() => setFitSignal((s) => s + 1)}>
                      <CornersOut size={14} weight="bold" /> {T("fit")}
                    </button>
                    <button className="btn q sm" disabled={!cloud.canUndo} onClick={doUndo}>
                      <ArrowCounterClockwise size={14} weight="bold" /> {T("undo")}
                    </button>
                    <button className="btn q sm" disabled={!cloud.canRedo} onClick={doRedo}>
                      <ArrowClockwise size={14} weight="bold" /> {T("redo")}
                    </button>
                    <button className="btn sm" disabled={!cloud.selection} onClick={doDelete}>
                      <Trash size={14} weight="bold" /> {T("deleteSelected")}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <aside className="insp">
              <div className="grp">
                <h4>{T("scan")}</h4>
                <dl className="kv">
                  <dt>{T("points")}</dt>
                  <dd>{nf.format(cloud.visibleCount)} {T("ofTotal")} {nf.format(cloud.count)}</dd>
                  <dt>{T("removed")}</dt>
                  <dd>{nf.format(cloud.removedCount)}</dd>
                  {extent && (
                    <>
                      <dt>{T("sizeWDH")}</dt>
                      <dd>
                        {extent.size.map((v) => formatLength(v, settings.displayUnit))
                          .join(" × ")} {UNIT_LABEL[settings.displayUnit]}
                      </dd>
                      <dt>{T("diagonal")}</dt>
                      <dd>{formatWithUnit(extent.diagonal, settings.displayUnit)}</dd>
                    </>
                  )}
                  <dt>{T("colour")}</dt>
                  <dd>{cloud.hasColor ? T("colourYes") : T("colourNo")}</dd>
                  <dt>{T("sourceFormat")}</dt>
                  <dd>{cloud.source.encoding}</dd>
                  <dt>{T("readIn")}</dt>
                  <dd>{(openMillis / 1000).toFixed(1)} s</dd>
                  <dt>{T("history")}</dt>
                  <dd>{cloud.undoDepth} {T("steps")}</dd>
                </dl>
              </div>

              <div className="grp">
                <h4>{T("sourceUnit")}</h4>
                <div className="seg quiet" role="group">
                  {UNITS.map((u) => (
                    <button key={u} aria-pressed={cloud.sourceUnit === u}
                      onClick={() => {
                        cloud.sourceUnit = u;
                        setMeasurements((prev) => prev.map((m) => ({
                          ...m, metres: cloud.distance(m.a, m.b),
                        })));
                        touch();
                      }}>
                      {UNIT_LABEL[u]}
                    </button>
                  ))}
                </div>
                <p className="quiet">{T("sourceUnitSub")}</p>
              </div>

              <div className="grp">
                <h4>{T("selection")}</h4>
                {cloud.selection ? (
                  <>
                    <dl className="kv">
                      <dt>{T("points")}</dt>
                      <dd>{nf.format(cloud.selection)}</dd>
                    </dl>
                    <button className="btn wide sm" onClick={doDelete}>
                      <Trash size={14} weight="bold" /> {T("deleteSelected")}
                    </button>
                    <button className="btn q wide sm" onClick={doKeep}>
                      {T("keepSelected")}
                    </button>
                    <button className="btn q wide sm"
                      onClick={() => { cloud.clearSelection(); touch(); }}>
                      {T("clearSelection")}
                    </button>
                  </>
                ) : (
                  <p className="quiet">{T("nothingSelected")}</p>
                )}
              </div>

              <div className="grp">
                <h4>{T("shownIn")}</h4>
                {/* The same setting as the one on the Settings screen, put
                    where the numbers it governs are read. Changing what you
                    read a length in should not be a trip to another screen,
                    and having it here also keeps it clearly apart from the
                    scan's own unit above, which is a different question. */}
                <div className="seg quiet" role="group">
                  {UNITS.map((u) => (
                    <button key={u} aria-pressed={settings.displayUnit === u}
                      onClick={() => setSettings((s) => ({ ...s, displayUnit: u }))}>
                      {UNIT_LABEL[u]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grp">
                <h4>{T("measurements")}</h4>
                {measurements.length === 0 ? (
                  <p className="quiet">{T("noMeasurements")}</p>
                ) : (
                  measurements.map((m) => (
                    <div key={m.id}
                      className={`mrow${m.id === selectedMeasurement ? " on" : ""}`}
                      onClick={() => setSelectedMeasurement(m.id)}>
                      <input value={m.name}
                        aria-label={T("measureName")}
                        onChange={(e) => renameMeasurement(m.id, e.target.value)} />
                      <span className="num">
                        {formatWithUnit(m.metres, settings.displayUnit)}
                      </span>
                      <button className="x" aria-label={T("deleteMeasurement")}
                        onClick={(e) => { e.stopPropagation(); removeMeasurement(m.id); }}>
                        <X size={13} weight="bold" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="grp sep">
                <h4>{T("export")}</h4>
                <button className="btn wide" onClick={saveProject}>
                  <FloppyDisk size={15} weight="bold" /> {T("exportProject")}
                </button>
                <p className="quiet">{T("exportProjectSub")}</p>
                <button className="btn q wide" onClick={exportPly}>
                  <Export size={15} weight="bold" /> {T("exportPly")}
                </button>
                <p className="quiet">{T("exportPlySub")}</p>
              </div>

              {cloud.removedCount > 0 && (
                <div className="grp sep">
                  <button className="btn q wide sm" onClick={() => {
                    const n = cloud.restoreAll();
                    touch();
                    say(`${T("restoredN")} ${nf.format(n)} ${T("points")}`);
                  }}>
                    {T("restoreAll")}
                  </button>
                </div>
              )}
            </aside>
          </div>
        )}

        {screen === "settings" && (
          <div className="set" key="settings">
            <nav className="snav">
              <button aria-current={settingsTab === "units"}
                onClick={() => setSettingsTab("units")}>{T("setUnits")}</button>
              <button aria-current={settingsTab === "display"}
                onClick={() => setSettingsTab("display")}>{T("setDisplay")}</button>
              <button aria-current={settingsTab === "about"}
                onClick={() => setSettingsTab("about")}>{T("setAbout")}</button>
            </nav>
            <div className="sbody">
              <div className="pset">
                {settingsTab === "units" && (
                  <>
                    <Row title={T("displayUnit")} sub={T("displayUnitSub")}>
                      <div className="seg quiet" role="group">
                        {UNITS.map((u) => (
                          <button key={u} aria-pressed={settings.displayUnit === u}
                            onClick={() => setSettings((s) => ({ ...s, displayUnit: u }))}>
                            {UNIT_LABEL[u]}
                          </button>
                        ))}
                      </div>
                    </Row>
                    <Row title={T("defaultSourceUnit")} sub={T("sourceUnitSub")}>
                      <div className="seg quiet" role="group">
                        <button aria-pressed={settings.defaultSourceUnit === "auto"}
                          onClick={() =>
                            setSettings((s) => ({ ...s, defaultSourceUnit: "auto" }))}>
                          {T("defaultSourceUnitAuto")}
                        </button>
                        {UNITS.map((u) => (
                          <button key={u} aria-pressed={settings.defaultSourceUnit === u}
                            onClick={() =>
                              setSettings((s) => ({ ...s, defaultSourceUnit: u }))}>
                            {UNIT_LABEL[u]}
                          </button>
                        ))}
                      </div>
                    </Row>
                  </>
                )}

                {settingsTab === "display" && (
                  <>
                    <Row title={T("theme")}>
                      <div className="seg quiet" role="group">
                        <button aria-pressed={settings.theme === "light"}
                          onClick={() => setSettings((s) => ({ ...s, theme: "light" }))}>
                          {T("themeLight")}
                        </button>
                        <button aria-pressed={settings.theme === "dark"}
                          onClick={() => setSettings((s) => ({ ...s, theme: "dark" }))}>
                          {T("themeDark")}
                        </button>
                      </div>
                    </Row>
                    <Row title={T("pointSize")} sub={T("pointSizeSub")}>
                      <div className="stepper">
                        <span className="unit">px</span>
                        <button aria-label="-" onClick={() => setSettings((s) => ({
                          ...s, pointSize: Math.max(1, s.pointSize - 1),
                        }))}>-</button>
                        <input readOnly value={settings.pointSize} />
                        <button aria-label="+" onClick={() => setSettings((s) => ({
                          ...s, pointSize: Math.min(12, s.pointSize + 1),
                        }))}>+</button>
                      </div>
                    </Row>
                    <Row title={T("attenuate")} sub={T("attenuateSub")}>
                      <button className="sw" role="switch"
                        aria-checked={settings.attenuate}
                        aria-label={T("attenuate")}
                        onClick={() =>
                          setSettings((s) => ({ ...s, attenuate: !s.attenuate }))} />
                    </Row>
                    <Row title={T("showStats")} sub={T("showStatsSub")}>
                      <button className="sw" role="switch"
                        aria-checked={settings.showStats}
                        aria-label={T("showStats")}
                        onClick={() =>
                          setSettings((s) => ({ ...s, showStats: !s.showStats }))} />
                    </Row>
                    <Row title={T("upAxis")} sub={T("upAxisSub")}>
                      <div className="seg quiet" role="group">
                        <button aria-pressed={settings.upAxis === "y"}
                          onClick={() => setSettings((s) => ({ ...s, upAxis: "y" }))}>
                          {T("upAxisY")}
                        </button>
                        <button aria-pressed={settings.upAxis === "z"}
                          onClick={() => setSettings((s) => ({ ...s, upAxis: "z" }))}>
                          {T("upAxisZ")}
                        </button>
                      </div>
                    </Row>
                  </>
                )}

                {settingsTab === "about" && (
                  <>
                    <Row title={T("appName")} sub={T("aboutBody")}>
                      <span className="num">{appVersion}</span>
                    </Row>
                    <Row title={T("renderer")}>
                      <span className="num">{rendererName || "WebGL"}</span>
                    </Row>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {dragOver && (
        <div className="dropveil"><div>{T("dropHere")}</div></div>
      )}

      {toast && (
        <div className={`toast${toast.bad ? " bad" : ""}`} role="status">
          <span>{toast.msg}</span>
          {toast.action && (
            <button onClick={toast.action.run}>{toast.action.label}</button>
          )}
        </div>
      )}

      <RendererProbe onName={setRendererName} />
    </div>
  );
}

/* --------------------------------------------------------------- fragments */

function Row(
  { title, sub, children }:
  { title: string; sub?: string; children: React.ReactNode },
) {
  return (
    <div className="srow">
      <div className="t">
        <b>{title}</b>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </div>
  );
}

function RecentCard(
  { recent, T, onOpen, onForget }:
  { recent: Recent; T: (k: Key) => string; onOpen: () => void; onForget: () => void },
) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let alive = true;
    shell.pathExists(recent.ref).then((ok) => { if (alive) setGone(!ok); });
    return () => { alive = false; };
  }, [recent.ref]);

  return (
    <div className={`card${gone ? " gone" : ""}`}>
      <button className="drop-x" aria-label={T("remove")}
        onClick={(e) => { e.stopPropagation(); onForget(); }}>
        <X size={12} weight="bold" />
      </button>
      <button
        style={{
          all: "unset", display: "flex", flexDirection: "column",
          cursor: gone ? "not-allowed" : "pointer", minWidth: 0,
        }}
        disabled={gone}
        onClick={onOpen}
      >
        <div className="shot">
          {recent.thumb
            ? <img src={recent.thumb} alt="" />
            : <span className="noshot"><Mark /><small>{T("scan")}</small></span>}
        </div>
        <div className="card-b">
          <b>{recent.name}</b>
          <span className="path">{recent.ref}</span>
          <div className="cardfoot">
            <span className="num">{nf.format(recent.points)}</span>
            <span>{T("points")}</span>
            {gone
              ? <span className="tag t-warn">{T("missing")}</span>
              : recent.measurements > 0
                ? <span className="tag t-quiet">
                    {recent.measurements} {T("measurements")}
                  </span>
                : null}
          </div>
        </div>
      </button>
    </div>
  );
}

/** Asks the driver what it is, once, so the About screen can say rather than
 *  claim. A throwaway context: keeping one open would hold a second GPU
 *  surface for the life of the app. */
function RendererProbe({ onName }: { onName: (s: string) => void }) {
  useEffect(() => {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) { onName("no WebGL"); return; }
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const name = ext
        ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER));
      onName(name);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      onName("WebGL");
    }
  }, [onName]);
  return null;
}
