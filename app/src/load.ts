/**
 * Opening a scan, from a reference to something on screen.
 *
 * The worker is imported inline so it survives the file:// origin the packaged
 * app runs on, where a module worker fetched as a separate file is blocked.
 * See vite.config.ts.
 */

import LoaderWorker from "./loader.worker?worker&inline";
import { PointCloud, type Measurement } from "./cloud";
import { refName, shell } from "./shell";
import { cloudFromSvxp, type SvxpManifest, type SvxpRaw, type SvxpView } from "./svxp";
import type { LoadResponse } from "./loader.worker";
import type { Unit } from "./units";

export interface Opened {
  cloud: PointCloud;
  /** Present only when a project was opened rather than a raw scan. */
  project: {
    manifest: SvxpManifest;
    measurements: Measurement[];
    view: SvxpView;
  } | null;
  /** How long the read took, wall clock, for the panel to report honestly. */
  millis: number;
}

export type LoadPhase =
  | { stage: "reading" }
  | { stage: "parsing"; fraction: number };

/**
 * Read a scan or a project and build the working cloud.
 *
 * `defaultUnit` is what a raw PLY is assumed to be in when the file gives no
 * clue, which it never does. A project carries its own and ignores this.
 */
export async function openScan(
  ref: string,
  defaultUnit: Unit | "auto",
  onPhase?: (p: LoadPhase) => void,
): Promise<Opened> {
  const started = performance.now();
  onPhase?.({ stage: "reading" });

  const read = await shell.readFile(ref);
  if (!read.ok) throw new Error(read.error);

  onPhase?.({ stage: "parsing", fraction: 0 });

  const worker = new LoaderWorker();
  try {
    // Progress is handled and swallowed inside the handler, so what the promise
    // settles with is only ever one of the three terminal messages.
    type Settled = Exclude<LoadResponse, { kind: "progress" }>;
    const response = await new Promise<Settled>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<LoadResponse>) => {
        if (e.data.kind === "progress") {
          onPhase?.({ stage: "parsing", fraction: e.data.fraction });
          return;
        }
        resolve(e.data);
      };
      worker.onerror = (e) =>
        reject(new Error(e.message || "The scan reader stopped unexpectedly."));
      worker.postMessage(
        { buffer: read.data, ref, name: read.name },
        [read.data],
      );
    });

    if (response.kind === "error") throw new Error(response.message);

    const name = stripExtension(read.name || refName(ref));

    if (response.kind === "svxp") {
      const raw = response.payload as unknown as SvxpRaw;
      return {
        cloud: cloudFromSvxp(raw, ref),
        project: {
          manifest: raw.manifest,
          measurements: raw.measurements,
          view: raw.view,
        },
        millis: performance.now() - started,
      };
    }

    const p = response.payload;
    const cloud = new PointCloud({
      positions: p.positions,
      colors: p.colors,
      count: p.count,
      offset: p.offset,
      min: p.min,
      max: p.max,
      hasColor: p.hasColor,
      sourceUnit: defaultUnit === "auto" ? p.guessedUnit : defaultUnit,
      source: {
        name,
        ref,
        originalCount: p.count,
        encoding: p.encoding,
        comments: p.comments,
      },
    });

    return { cloud, project: null, millis: performance.now() - started };
  } finally {
    worker.terminate();
  }
}

function stripExtension(fileName: string): string {
  const cut = fileName.lastIndexOf(".");
  return cut > 0 ? fileName.slice(0, cut) : fileName;
}
