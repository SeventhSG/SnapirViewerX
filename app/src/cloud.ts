/**
 * The scan being worked on, and everything that can be done to it.
 *
 * One point cloud is three parallel arrays and nothing else: positions,
 * colours, and one byte of state per point. Deleting does not move or shrink
 * anything - it sets a bit. That is what makes undo cheap enough to be
 * unlimited in practice, what keeps the GPU buffer stable so a delete costs
 * one small upload instead of a re-allocation of a quarter of a gigabyte, and
 * what lets a point come back exactly where it was.
 *
 * Positions stay in the file's own units. The source unit is a number applied
 * when a length is computed, never baked into the buffer, so correcting a scan
 * that turned out to be in millimetres is instant and lossless rather than a
 * pass over twenty million floats that can only be undone approximately.
 */

import { type Unit, sourceScale } from "./units";

export const FLAG_DELETED = 1;
export const FLAG_SELECTED = 2;

export interface CloudSource {
  /** What the scan is called on screen. */
  name: string;
  /** Where it came from, or a synthetic reference for a dropped file. */
  ref: string;
  /** Points as the file declared them, before anything was deleted. */
  originalCount: number;
  encoding: string;
  comments: string[];
}

export interface CloudInit {
  positions: Float32Array;
  colors: Uint8Array;
  count: number;
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  hasColor: boolean;
  sourceUnit: Unit;
  source: CloudSource;
  /** Points already deleted when the scan was reopened from a project. */
  deleted?: Uint32Array;
}

/** One undoable step. Only the indices it touched, so a step costs 4 bytes a
 *  point rather than a copy of the cloud. */
interface Edit {
  kind: "delete";
  indices: Uint32Array;
}

export class PointCloud {
  readonly positions: Float32Array;
  readonly colors: Uint8Array;
  readonly state: Uint8Array;
  readonly count: number;
  readonly offset: [number, number, number];
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  readonly hasColor: boolean;
  readonly source: CloudSource;

  sourceUnit: Unit;

  private undoStack: Edit[] = [];
  private redoStack: Edit[] = [];
  private deletedCount = 0;
  private selectedCount = 0;

  /** Bumped by anything that changes what is on screen, so the viewport knows
   *  to re-upload the state buffer without diffing twenty million bytes. */
  revision = 0;

  constructor(init: CloudInit) {
    this.positions = init.positions;
    this.colors = init.colors;
    this.count = init.count;
    this.offset = init.offset;
    this.min = init.min;
    this.max = init.max;
    this.hasColor = init.hasColor;
    this.sourceUnit = init.sourceUnit;
    this.source = init.source;
    this.state = new Uint8Array(init.count);

    if (init.deleted?.length) {
      for (const i of init.deleted) {
        if (i < init.count && !(this.state[i] & FLAG_DELETED)) {
          this.state[i] |= FLAG_DELETED;
          this.deletedCount++;
        }
      }
    }
  }

  /* ------------------------------------------------------------- readings */

  /** Metres per one unit of the stored coordinates. */
  get metresPerUnit(): number {
    return sourceScale(this.sourceUnit);
  }

  get visibleCount(): number { return this.count - this.deletedCount; }
  get removedCount(): number { return this.deletedCount; }
  get selection(): number { return this.selectedCount; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoDepth(): number { return this.undoStack.length; }

  /**
   * The box around what is still there, in the cloud's own units.
   *
   * Recomputed rather than cached, because after a crop the box the parser
   * measured is a lie: framing the camera on it would pull back to include
   * the wall that was just cut away. A pass over the cloud costs a few
   * milliseconds and is only done when the view is re-framed or the panel is
   * read, not per frame.
   */
  liveBounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const { positions, state, count } = this;
    let seen = 0;
    for (let i = 0; i < count; i++) {
      if (state[i] & FLAG_DELETED) continue;
      const o = i * 3;
      const x = positions[o], y = positions[o + 1], z = positions[o + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      seen++;
    }
    if (!seen) return null;
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  }

  /** The same box in metres, as width/depth/height plus its diagonal. */
  extent(): { size: [number, number, number]; diagonal: number } | null {
    const b = this.liveBounds();
    if (!b) return null;
    const s = this.metresPerUnit;
    const size: [number, number, number] = [
      (b.max[0] - b.min[0]) * s,
      (b.max[1] - b.min[1]) * s,
      (b.max[2] - b.min[2]) * s,
    ];
    return { size, diagonal: Math.hypot(size[0], size[1], size[2]) };
  }

  /** Distance in metres between two points, by index. */
  distance(a: number, b: number): number {
    const s = this.metresPerUnit;
    const ao = a * 3, bo = b * 3;
    return Math.hypot(
      this.positions[ao] - this.positions[bo],
      this.positions[ao + 1] - this.positions[bo + 1],
      this.positions[ao + 2] - this.positions[bo + 2],
    ) * s;
  }

  pointAt(i: number): [number, number, number] {
    const o = i * 3;
    return [this.positions[o], this.positions[o + 1], this.positions[o + 2]];
  }

  isDeleted(i: number): boolean { return (this.state[i] & FLAG_DELETED) !== 0; }

  /* ----------------------------------------------------------- selection */

  clearSelection(): void {
    if (!this.selectedCount) return;
    const { state, count } = this;
    for (let i = 0; i < count; i++) state[i] &= ~FLAG_SELECTED;
    this.selectedCount = 0;
    this.revision++;
  }

  /**
   * Mark every live point the test accepts.
   *
   * `mode` is what a modifier key means in every CAD package: a plain drag
   * replaces the selection, shift adds to it, alt takes away. The test is
   * called once per point, so it has to be cheap - in practice it is four
   * plane evaluations.
   */
  selectWhere(
    test: (x: number, y: number, z: number) => boolean,
    mode: "replace" | "add" | "subtract" = "replace",
  ): number {
    const { positions, state, count } = this;
    if (mode === "replace") this.clearSelection();

    let changed = 0;
    for (let i = 0; i < count; i++) {
      if (state[i] & FLAG_DELETED) continue;
      const o = i * 3;
      if (!test(positions[o], positions[o + 1], positions[o + 2])) continue;

      const had = (state[i] & FLAG_SELECTED) !== 0;
      if (mode === "subtract") {
        if (had) { state[i] &= ~FLAG_SELECTED; this.selectedCount--; changed++; }
      } else if (!had) {
        state[i] |= FLAG_SELECTED; this.selectedCount++; changed++;
      }
    }
    if (changed) this.revision++;
    return changed;
  }

  /**
   * Select everything inside a rectangle drawn on screen.
   *
   * `m` is the object-to-clip matrix in column-major order, exactly as three.js
   * keeps it. The rectangle is in normalised device coordinates, so -1 to 1 on
   * both axes with y up.
   *
   * This is a prism test, not a visibility test: a point behind the wall you
   * dragged over is inside the prism and is selected. That is what the tool is
   * for. Cleaning a scan means cutting out the passer-by standing in front of
   * the wall AND their reflection behind it, and a viewer that only selected
   * what the camera could see would make that two operations from two angles.
   *
   * The arithmetic is done in clip space rather than by dividing through to
   * NDC, because the division is the expensive part and the comparison works
   * just as well multiplied out: x/w >= x0 is x >= x0*w whenever w > 0.
   */
  selectByClipRect(
    m: ArrayLike<number>,
    rect: { x0: number; x1: number; y0: number; y1: number },
    mode: "replace" | "add" | "subtract" = "replace",
  ): number {
    if (mode === "replace") this.clearSelection();

    // Column-major: element(row, col) is m[col * 4 + row].
    const m0 = m[0], m4 = m[4], m8 = m[8], m12 = m[12];     // row 0 -> clip.x
    const m1 = m[1], m5 = m[5], m9 = m[9], m13 = m[13];     // row 1 -> clip.y
    const m3 = m[3], m7 = m[7], m11 = m[11], m15 = m[15];   // row 3 -> clip.w

    const { x0, x1, y0, y1 } = rect;
    const { positions, state, count } = this;
    let changed = 0;

    for (let i = 0; i < count; i++) {
      if (state[i] & FLAG_DELETED) continue;
      const o = i * 3;
      const px = positions[o], py = positions[o + 1], pz = positions[o + 2];

      const w = m3 * px + m7 * py + m11 * pz + m15;
      if (w <= 0) continue;                     // behind the eye

      const cx = m0 * px + m4 * py + m8 * pz + m12;
      if (cx < x0 * w || cx > x1 * w) continue;

      const cy = m1 * px + m5 * py + m9 * pz + m13;
      if (cy < y0 * w || cy > y1 * w) continue;

      const had = (state[i] & FLAG_SELECTED) !== 0;
      if (mode === "subtract") {
        if (had) { state[i] &= ~FLAG_SELECTED; this.selectedCount--; changed++; }
      } else if (!had) {
        state[i] |= FLAG_SELECTED; this.selectedCount++; changed++;
      }
    }

    if (changed) this.revision++;
    return changed;
  }

  /**
   * The point under the cursor, or null.
   *
   * Two passes, and the reason is worth stating because the obvious one-pass
   * version is subtly wrong.
   *
   * Taking simply the nearest point to the camera within the pick radius does
   * stop a measurement snapping through a wall to the room behind, which is
   * essential: that error is invisible on screen and silently wrong. But it
   * also drags every pick towards the viewer. Aim at the corner of a ceiling
   * and the winner is whichever point in the disc leans furthest forward,
   * which near a receding surface is consistently the one further inside the
   * face. Measuring a room corner to corner that way came back short by
   * roughly the pick radius every time, and the number looked plausible.
   *
   * So: the first pass finds the depth of the nearest surface under the
   * cursor, and the second takes the point closest to where the operator
   * actually pointed from among those sitting on that surface. The wall
   * behind is still excluded, and the corner is now the corner.
   */
  pickNearest(
    m: ArrayLike<number>,
    ndcX: number,
    ndcY: number,
    halfWidthPx: number,
    halfHeightPx: number,
    radiusPx: number,
  ): number | null {
    const m0 = m[0], m4 = m[4], m8 = m[8], m12 = m[12];
    const m1 = m[1], m5 = m[5], m9 = m[9], m13 = m[13];
    const m3 = m[3], m7 = m[7], m11 = m[11], m15 = m[15];

    const { positions, state, count } = this;
    const r2 = radiusPx * radiusPx;

    let nearest = Infinity;
    for (let i = 0; i < count; i++) {
      if (state[i] & FLAG_DELETED) continue;
      const o = i * 3;
      const px = positions[o], py = positions[o + 1], pz = positions[o + 2];

      const w = m3 * px + m7 * py + m11 * pz + m15;
      if (w <= 0 || w >= nearest) continue;

      const cx = m0 * px + m4 * py + m8 * pz + m12;
      const dx = (cx / w - ndcX) * halfWidthPx;
      if (dx * dx > r2) continue;

      const cy = m1 * px + m5 * py + m9 * pz + m13;
      const dy = (cy / w - ndcY) * halfHeightPx;
      if (dx * dx + dy * dy > r2) continue;

      nearest = w;
    }
    if (nearest === Infinity) return null;

    // How much further than the nearest hit still counts as the same surface.
    // Proportional, so it means the same thing whether the scan is in metres
    // or millimetres, and loose enough to hold a whole wall seen at a slant.
    const depthLimit = nearest * 1.02;

    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < count; i++) {
      if (state[i] & FLAG_DELETED) continue;
      const o = i * 3;
      const px = positions[o], py = positions[o + 1], pz = positions[o + 2];

      const w = m3 * px + m7 * py + m11 * pz + m15;
      if (w <= 0 || w > depthLimit) continue;

      const cx = m0 * px + m4 * py + m8 * pz + m12;
      const dx = (cx / w - ndcX) * halfWidthPx;
      if (dx * dx > r2) continue;

      const cy = m1 * px + m5 * py + m9 * pz + m13;
      const dy = (cy / w - ndcY) * halfHeightPx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2 || d2 >= bestDist) continue;

      best = i;
      bestDist = d2;
    }

    return best;
  }

  selectAll(): void {
    const { state, count } = this;
    let n = 0;
    for (let i = 0; i < count; i++) {
      if (state[i] & FLAG_DELETED) continue;
      state[i] |= FLAG_SELECTED;
      n++;
    }
    this.selectedCount = n;
    this.revision++;
  }

  invertSelection(): void {
    const { state, count } = this;
    let n = 0;
    for (let i = 0; i < count; i++) {
      if (state[i] & FLAG_DELETED) continue;
      state[i] ^= FLAG_SELECTED;
      if (state[i] & FLAG_SELECTED) n++;
    }
    this.selectedCount = n;
    this.revision++;
  }

  /* --------------------------------------------------------------- edits */

  /** Remove the selected points. Returns how many went. */
  deleteSelected(): number {
    return this.applyDelete((s) => (s & FLAG_SELECTED) !== 0);
  }

  /** Remove everything except the selection. The other half of a crop. */
  keepSelected(): number {
    if (!this.selectedCount) return 0;
    return this.applyDelete((s) => (s & FLAG_SELECTED) === 0);
  }

  private applyDelete(doomed: (state: number) => boolean): number {
    const { state, count } = this;
    let n = 0;
    for (let i = 0; i < count; i++) {
      if (!(state[i] & FLAG_DELETED) && doomed(state[i])) n++;
    }
    if (!n) return 0;

    const indices = new Uint32Array(n);
    let k = 0;
    for (let i = 0; i < count; i++) {
      if (state[i] & FLAG_DELETED) continue;
      if (!doomed(state[i])) continue;
      indices[k++] = i;
      state[i] = (state[i] & ~FLAG_SELECTED) | FLAG_DELETED;
    }

    this.deletedCount += n;
    this.selectedCount = 0;
    // Anything still selected but not deleted has to lose the bit too, or the
    // count above and the bits below stop agreeing.
    for (let i = 0; i < count; i++) state[i] &= ~FLAG_SELECTED;

    this.undoStack.push({ kind: "delete", indices });
    // A new edit is a new branch. Keeping the old redo entries would let a
    // later redo restore points that this edit never removed.
    this.redoStack.length = 0;
    this.revision++;
    return n;
  }

  undo(): number {
    const edit = this.undoStack.pop();
    if (!edit) return 0;
    for (const i of edit.indices) {
      if (this.state[i] & FLAG_DELETED) {
        this.state[i] &= ~FLAG_DELETED;
        this.deletedCount--;
      }
    }
    this.redoStack.push(edit);
    this.revision++;
    return edit.indices.length;
  }

  redo(): number {
    const edit = this.redoStack.pop();
    if (!edit) return 0;
    for (const i of edit.indices) {
      if (!(this.state[i] & FLAG_DELETED)) {
        this.state[i] |= FLAG_DELETED;
        this.deletedCount++;
      }
    }
    this.undoStack.push(edit);
    this.revision++;
    return edit.indices.length;
  }

  /** Put every deleted point back and forget the history. */
  restoreAll(): number {
    if (!this.deletedCount) return 0;
    const n = this.deletedCount;
    for (let i = 0; i < this.count; i++) this.state[i] &= ~FLAG_DELETED;
    this.deletedCount = 0;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.revision++;
    return n;
  }

  /** Every deleted index, for writing into a project file. */
  deletedIndices(): Uint32Array {
    const out = new Uint32Array(this.deletedCount);
    let k = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] & FLAG_DELETED) out[k++] = i;
    }
    return out;
  }

  /** The surviving points, packed down, for an export that has to be a plain
   *  cloud rather than a cloud plus a list of holes. */
  compact(): { positions: Float32Array; colors: Uint8Array; count: number } {
    const n = this.visibleCount;
    const positions = new Float32Array(n * 3);
    const colors = new Uint8Array(n * 3);
    let k = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] & FLAG_DELETED) continue;
      const src = i * 3, dst = k * 3;
      positions[dst] = this.positions[src];
      positions[dst + 1] = this.positions[src + 1];
      positions[dst + 2] = this.positions[src + 2];
      colors[dst] = this.colors[src];
      colors[dst + 1] = this.colors[src + 1];
      colors[dst + 2] = this.colors[src + 2];
      k++;
    }
    return { positions, colors, count: n };
  }
}

/* ------------------------------------------------------------ measurements */

export interface Measurement {
  id: string;
  /** Indices into the cloud. Kept as indices, not coordinates, so a
   *  measurement always lands exactly on the points it was taken between. */
  a: number;
  b: number;
  /** Metres. Stored rather than recomputed so a reopened project reads the
   *  same number even if the source unit is later corrected by hand. */
  metres: number;
  name: string;
}

export function newMeasurementId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The default name for the nth measurement. Numbered, not invented. */
export function defaultMeasurementName(index: number): string {
  return `Measurement ${index + 1}`;
}
