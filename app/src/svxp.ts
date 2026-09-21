/**
 * `.svxp` - the Snapir Viewer X project file.
 *
 * A ZIP container. Not a clever format: a ZIP means any operator can open one
 * with the tools already on their machine and see exactly what their data is,
 * and it means a future reader does not need this program to exist.
 *
 * The important decision is that a project holds the WHOLE scan plus a list of
 * which points are deleted, not the surviving points. Editing here is
 * non-destructive on purpose. Reopening a project a year later and putting a
 * wall back has to be possible, and that is only true if the wall is still in
 * the file. It does mean a project does not shrink as you clean it. Exporting
 * a `.ply` is what produces a file with the deleted points actually gone.
 *
 * The two bulk entries are stored uncompressed. Float32 coordinates are close
 * to incompressible, and deflating a quarter of a gigabyte to save two percent
 * would add a minute to every save. Everything small is deflated normally.
 *
 * See docs/SVXP.md for the specification this implements.
 */

import { unzipSync, zipSync } from "fflate";
import { PointCloud, type Measurement } from "./cloud";
import { type Unit } from "./units";

export const SVXP_FORMAT_VERSION = 1;

export interface SvxpManifest {
  format: "svxp";
  formatVersion: number;
  writer: { name: string; version: string };
  created: string;
  modified: string;
  scan: {
    name: string;
    sourceFile: string;
    sourceEncoding: string;
    sourceUnit: Unit;
    /** Points in the file. Deleted ones are included: they are still here. */
    pointCount: number;
    deletedCount: number;
    hasColor: boolean;
    /** Added to a stored coordinate, recovers the original file coordinate. */
    offset: [number, number, number];
    min: [number, number, number];
    max: [number, number, number];
    comments: string[];
  };
}

export interface SvxpView {
  displayUnit: Unit;
  pointSize: number;
  background: "light" | "dark";
}

/**
 * What a read produces, before anything class-shaped exists.
 *
 * Deliberately plain: reading happens in a worker, and a worker can only post
 * data. The `PointCloud` is assembled from this on the other side by
 * `cloudFromSvxp`, so the parse cost stays off the interface thread and the
 * big arrays cross the boundary by transfer rather than by copy.
 */
export interface SvxpRaw {
  manifest: SvxpManifest;
  positions: Float32Array;
  colors: Uint8Array;
  count: number;
  deleted: Uint32Array | null;
  measurements: Measurement[];
  view: SvxpView;
  thumbnail: Uint8Array | null;
}

export class SvxpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvxpError";
  }
}

/* -------------------------------------------------------------- alignment
   fflate hands back views into a shared buffer, and a typed-array view needs
   its byte offset to be a multiple of the element size. Copying only when it
   is not keeps the common case free. */

function asFloat32(b: Uint8Array): Float32Array {
  if (b.byteLength % 4 !== 0) {
    throw new SvxpError("points.bin is not a whole number of coordinates.");
  }
  if (b.byteOffset % 4 === 0) {
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  }
  return new Float32Array(b.slice().buffer);
}

function asUint32(b: Uint8Array): Uint32Array {
  if (b.byteLength % 4 !== 0) {
    throw new SvxpError("deleted.bin is not a whole number of indices.");
  }
  if (b.byteOffset % 4 === 0) {
    return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  }
  return new Uint32Array(b.slice().buffer);
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

/* ------------------------------------------------------------------ write */

export interface WriteOptions {
  measurements: Measurement[];
  view: SvxpView;
  thumbnail?: Uint8Array | null;
  /** The manifest of the project this one came from, if it was reopened, so
   *  the original creation time survives a round trip. */
  created?: string;
  appVersion: string;
}

export function writeSvxp(cloud: PointCloud, opts: WriteOptions): Uint8Array {
  const now = new Date().toISOString();

  const manifest: SvxpManifest = {
    format: "svxp",
    formatVersion: SVXP_FORMAT_VERSION,
    writer: { name: "Snapir Viewer X", version: opts.appVersion },
    created: opts.created || now,
    modified: now,
    scan: {
      name: cloud.source.name,
      sourceFile: cloud.source.ref,
      sourceEncoding: cloud.source.encoding,
      sourceUnit: cloud.sourceUnit,
      pointCount: cloud.count,
      deletedCount: cloud.removedCount,
      hasColor: cloud.hasColor,
      offset: cloud.offset,
      min: cloud.min,
      max: cloud.max,
      comments: cloud.source.comments,
    },
  };

  const deleted = cloud.deletedIndices();

  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    "manifest.json": [bytes(JSON.stringify(manifest, null, 2)), { level: 6 }],
    "points.bin": [
      new Uint8Array(cloud.positions.buffer, cloud.positions.byteOffset,
        cloud.positions.byteLength),
      { level: 0 },
    ],
    "colors.bin": [cloud.colors, { level: 0 }],
    "measurements.json": [
      bytes(JSON.stringify(opts.measurements, null, 2)), { level: 6 },
    ],
    "view.json": [bytes(JSON.stringify(opts.view, null, 2)), { level: 6 }],
  };

  if (deleted.length) {
    files["deleted.bin"] = [
      new Uint8Array(deleted.buffer, deleted.byteOffset, deleted.byteLength),
      { level: 6 },   // sorted ascending indices deflate very well
    ];
  }
  if (opts.thumbnail?.length) {
    files["thumbnail.png"] = [opts.thumbnail, { level: 0 }];  // already deflated
  }

  return zipSync(files, { mtime: new Date() });
}

/* ------------------------------------------------------------------- read */

export function readSvxp(buffer: ArrayBuffer): SvxpRaw {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new SvxpError(
      "This file is not readable as a project. A .svxp is a ZIP container, "
      + "and this one's directory could not be read.",
    );
  }

  if (!entries["manifest.json"]) {
    throw new SvxpError("This project has no manifest.json, so it is not a .svxp.");
  }

  let manifest: SvxpManifest;
  try {
    manifest = JSON.parse(text(entries["manifest.json"]));
  } catch {
    throw new SvxpError("This project's manifest.json is not valid JSON.");
  }

  if (manifest.format !== "svxp") {
    throw new SvxpError("This file says it is not a Snapir Viewer X project.");
  }
  if (manifest.formatVersion > SVXP_FORMAT_VERSION) {
    throw new SvxpError(
      `This project was written by a newer Snapir Viewer X `
      + `(format ${manifest.formatVersion}, this build reads `
      + `${SVXP_FORMAT_VERSION}). Update to open it.`,
    );
  }

  const pointsRaw = entries["points.bin"];
  const colorsRaw = entries["colors.bin"];
  if (!pointsRaw || !colorsRaw) {
    throw new SvxpError("This project is missing its point data.");
  }

  const positions = asFloat32(pointsRaw);
  const colors = colorsRaw;
  const count = manifest.scan.pointCount;

  if (positions.length !== count * 3 || colors.length !== count * 3) {
    throw new SvxpError(
      `This project is inconsistent: the manifest declares `
      + `${count.toLocaleString()} points but the data holds `
      + `${Math.floor(positions.length / 3).toLocaleString()}.`,
    );
  }

  const deleted = entries["deleted.bin"] ? asUint32(entries["deleted.bin"]) : null;

  let measurements: Measurement[] = [];
  if (entries["measurements.json"]) {
    try {
      const parsed = JSON.parse(text(entries["measurements.json"]));
      // Anything pointing outside the cloud would draw a line to nowhere, so
      // it is dropped rather than carried into the session.
      if (Array.isArray(parsed)) {
        measurements = parsed.filter(
          (m: Measurement) =>
            Number.isInteger(m?.a) && Number.isInteger(m?.b)
            && m.a >= 0 && m.a < count && m.b >= 0 && m.b < count,
        );
      }
    } catch { /* a project with unreadable measurements still has its cloud */ }
  }

  let view: SvxpView = { displayUnit: "m", pointSize: 2, background: "light" };
  if (entries["view.json"]) {
    try {
      view = { ...view, ...JSON.parse(text(entries["view.json"])) };
    } catch { /* fall back to the defaults above */ }
  }

  return {
    manifest,
    positions,
    colors,
    count,
    deleted,
    measurements,
    view,
    thumbnail: entries["thumbnail.png"] || null,
  };
}

/** Assemble the working cloud from a read. Runs wherever the interface does,
 *  because a class cannot cross a worker boundary. */
export function cloudFromSvxp(raw: SvxpRaw, ref: string): PointCloud {
  return new PointCloud({
    positions: raw.positions,
    colors: raw.colors,
    count: raw.count,
    offset: raw.manifest.scan.offset,
    min: raw.manifest.scan.min,
    max: raw.manifest.scan.max,
    hasColor: raw.manifest.scan.hasColor,
    sourceUnit: raw.manifest.scan.sourceUnit,
    source: {
      name: raw.manifest.scan.name,
      ref,
      originalCount: raw.count,
      encoding: raw.manifest.scan.sourceEncoding,
      comments: raw.manifest.scan.comments || [],
    },
    deleted: raw.deleted || undefined,
  });
}

/** Is this buffer a ZIP, and therefore a project rather than a raw scan?
 *  Checked by signature rather than by file extension, because a scan renamed
 *  to .svxp should fail with a sentence rather than a stack trace. */
export function looksLikeSvxp(buffer: ArrayBuffer): boolean {
  const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b
    && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06);
}
