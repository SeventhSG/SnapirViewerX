/**
 * Reads a scan off the interface thread.
 *
 * Parsing twenty million points takes seconds whatever you do, and doing it on
 * the main thread means the window stops answering the compositor: no progress
 * bar, no cancel, and Windows offering to close the program. Here it is one
 * message in, progress out, and the finished buffers handed back by transfer
 * so the biggest arrays in the app are never copied.
 */

import { PlyError, readPly, shuffleCloud } from "./ply";
import { SvxpError, looksLikeSvxp, readSvxp } from "./svxp";
import { guessSourceUnit } from "./units";

export interface LoadRequest {
  buffer: ArrayBuffer;
  ref: string;
  name: string;
}

export type LoadResponse =
  | { kind: "progress"; fraction: number }
  | { kind: "ply"; payload: PlyPayload }
  | { kind: "svxp"; payload: SvxpPayload }
  | { kind: "error"; message: string };

export interface PlyPayload {
  positions: Float32Array;
  colors: Uint8Array;
  count: number;
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  hasColor: boolean;
  encoding: string;
  comments: string[];
  /** Offered as the default source unit, from the size of the thing. */
  guessedUnit: ReturnType<typeof guessSourceUnit>;
}

export interface SvxpPayload {
  manifest: unknown;
  positions: Float32Array;
  colors: Uint8Array;
  count: number;
  deleted: Uint32Array | null;
  measurements: unknown[];
  view: unknown;
  thumbnail: Uint8Array | null;
}

const post = (msg: LoadResponse, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? []);

self.onmessage = (e: MessageEvent<LoadRequest>) => {
  const { buffer, name } = e.data;

  try {
    if (looksLikeSvxp(buffer)) {
      const raw = readSvxp(buffer);
      const payload: SvxpPayload = {
        manifest: raw.manifest,
        positions: raw.positions,
        colors: raw.colors,
        count: raw.count,
        deleted: raw.deleted,
        measurements: raw.measurements,
        view: raw.view,
        thumbnail: raw.thumbnail,
      };
      post({ kind: "svxp", payload }, [payload.positions.buffer, payload.colors.buffer]);
      return;
    }

    let last = -1;
    const cloud = readPly(buffer, (f) => {
      // One message per whole percent. Below that the postMessage traffic
      // starts costing more than the parse it is reporting on.
      const pct = Math.floor(f * 100);
      if (pct === last) return;
      last = pct;
      post({ kind: "progress", fraction: f });
    });

    // Scrambled here rather than in the reader, so that the reader stays a
    // reader and a project reopened from disk keeps the order its stored
    // indices were written against. See shuffleCloud for why at all.
    shuffleCloud(cloud.positions, cloud.colors, cloud.count);

    const size = Math.hypot(
      cloud.max[0] - cloud.min[0],
      cloud.max[1] - cloud.min[1],
      cloud.max[2] - cloud.min[2],
    );

    const payload: PlyPayload = {
      positions: cloud.positions,
      colors: cloud.colors,
      count: cloud.count,
      offset: cloud.offset,
      min: cloud.min,
      max: cloud.max,
      hasColor: cloud.hasColor,
      encoding: cloud.encoding,
      comments: cloud.comments,
      guessedUnit: guessSourceUnit(size),
    };
    post({ kind: "ply", payload }, [payload.positions.buffer, payload.colors.buffer]);
  } catch (err) {
    // A parse error is a sentence about the file. Anything else is a bug here,
    // and saying which of the two it is saves the operator guessing.
    const known = err instanceof PlyError || err instanceof SvxpError;
    post({
      kind: "error",
      message: known
        ? (err as Error).message
        : `${name} could not be read: ${String((err as Error)?.message || err)}`,
    });
  }
};
