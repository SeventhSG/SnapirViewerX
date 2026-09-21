/**
 * PLY reader.
 *
 * Covers the three encodings the format defines - ascii, binary_little_endian
 * and binary_big_endian - and the property spellings the iPhone and iPad
 * scanning apps actually emit, which are not all the same. Polycam and
 * Scaniverse write `red green blue`; some Record3D exports write `r g b`;
 * meshing tools that round-trip through MeshLab write `diffuse_red` and
 * friends. All three are read.
 *
 * Two decisions worth knowing about:
 *
 * Positions come back as float32 measured from the first vertex, not from the
 * file's own zero. A float32 holds about seven significant digits, so a scan
 * sitting at a survey coordinate of 4,500,000 would quantise to roughly 30 cm
 * and every measurement taken off it would be noise. Subtracting a nearby
 * origin first keeps the full precision of the instrument no matter where the
 * file thinks it is, and `offset` carries the part that was taken out.
 *
 * Faces are skipped, not rejected. A scan exported as a mesh still has the
 * vertices we want, and the list property is walked correctly so that a file
 * with both reads as the point cloud inside it rather than as an error.
 */

export type PlyEncoding = "ascii" | "binary_little_endian" | "binary_big_endian";

export type ScalarType =
  | "int8" | "uint8" | "int16" | "uint16"
  | "int32" | "uint32" | "float32" | "float64";

const TYPE_ALIASES: Record<string, ScalarType> = {
  char: "int8", int8: "int8",
  uchar: "uint8", uint8: "uint8",
  short: "int16", int16: "int16",
  ushort: "uint16", uint16: "uint16",
  int: "int32", int32: "int32",
  uint: "uint32", uint32: "uint32",
  float: "float32", float32: "float32",
  double: "float64", float64: "float64",
};

const TYPE_SIZE: Record<ScalarType, number> = {
  int8: 1, uint8: 1, int16: 2, uint16: 2,
  int32: 4, uint32: 4, float32: 4, float64: 8,
};

export interface PlyProperty {
  name: string;
  /** A list property has a count type and an item type; a scalar has neither. */
  list: boolean;
  countType?: ScalarType;
  type: ScalarType;
  /** Byte offset inside one element record. Only meaningful when no list
   *  property precedes it, which is the case for every vertex layout. */
  offset: number;
}

export interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
  /** Bytes per record, or null when the element contains a list. */
  stride: number | null;
}

export interface PlyHeader {
  encoding: PlyEncoding;
  version: string;
  elements: PlyElement[];
  comments: string[];
  /** Byte index of the first byte after `end_header` and its newline. */
  dataStart: number;
}

export class PlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlyError";
  }
}

/* ------------------------------------------------------------------ header */

const MAGIC = [0x70, 0x6c, 0x79];  // "ply"

/** Find `end_header`, and return the header text plus where the body starts.
 *  Scanned bytewise because the body may not be text at all, and because
 *  decoding a 400 MB buffer to a string to find a token 300 bytes in is the
 *  single most expensive mistake this file could make. */
function splitHeader(bytes: Uint8Array): { text: string; dataStart: number } {
  const NEEDLE = "end_header";
  const limit = Math.min(bytes.length, 1 << 20);  // no real header is near 1 MB
  for (let i = 0; i + NEEDLE.length <= limit; i++) {
    if (bytes[i] !== 0x65) continue;  // 'e'
    let hit = true;
    for (let j = 1; j < NEEDLE.length; j++) {
      if (bytes[i + j] !== NEEDLE.charCodeAt(j)) { hit = false; break; }
    }
    if (!hit) continue;
    // Walk past the token to the end of its line, tolerating \r\n.
    let k = i + NEEDLE.length;
    while (k < bytes.length && bytes[k] !== 0x0a) k++;
    return {
      text: new TextDecoder("utf-8").decode(bytes.subarray(0, i)),
      dataStart: k + 1,
    };
  }
  throw new PlyError("This file has no PLY header. It may not be a PLY file.");
}

export function parseHeader(bytes: Uint8Array): PlyHeader {
  if (bytes.length < 4 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new PlyError("This is not a PLY file: it does not start with \"ply\".");
  }

  const { text, dataStart } = splitHeader(bytes);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let encoding: PlyEncoding | null = null;
  let version = "1.0";
  const elements: PlyElement[] = [];
  const comments: string[] = [];

  for (const line of lines) {
    const parts = line.split(/\s+/);
    const keyword = parts[0];

    if (keyword === "ply") continue;

    if (keyword === "comment" || keyword === "obj_info") {
      comments.push(parts.slice(1).join(" "));
      continue;
    }

    if (keyword === "format") {
      const [, enc, ver] = parts;
      if (enc !== "ascii" && enc !== "binary_little_endian"
          && enc !== "binary_big_endian") {
        throw new PlyError(`Unknown PLY encoding "${enc}".`);
      }
      encoding = enc;
      version = ver || "1.0";
      continue;
    }

    if (keyword === "element") {
      const count = Number(parts[2]);
      if (!Number.isFinite(count) || count < 0) {
        throw new PlyError(`Element "${parts[1]}" has no usable count.`);
      }
      elements.push({ name: parts[1], count, properties: [], stride: 0 });
      continue;
    }

    if (keyword === "property") {
      const el = elements[elements.length - 1];
      if (!el) throw new PlyError("A property appears before any element.");

      if (parts[1] === "list") {
        const countType = TYPE_ALIASES[parts[2]];
        const itemType = TYPE_ALIASES[parts[3]];
        if (!countType || !itemType) {
          throw new PlyError(`Unknown type in list property "${parts[4]}".`);
        }
        el.properties.push({
          name: parts[4], list: true, countType, type: itemType, offset: -1,
        });
        el.stride = null;   // a list makes the record length vary per record
      } else {
        const type = TYPE_ALIASES[parts[1]];
        if (!type) throw new PlyError(`Unknown property type "${parts[1]}".`);
        const offset = el.stride === null ? -1 : el.stride;
        el.properties.push({ name: parts[2], list: false, type, offset });
        if (el.stride !== null) el.stride += TYPE_SIZE[type];
      }
      continue;
    }
  }

  if (!encoding) throw new PlyError("The PLY header has no format line.");
  if (!elements.length) throw new PlyError("The PLY header declares no elements.");

  return { encoding, version, elements, comments, dataStart };
}

/* --------------------------------------------------------- property lookup */

/** The first property whose name matches, case-insensitively. */
function find(el: PlyElement, names: string[]): PlyProperty | null {
  for (const want of names) {
    const hit = el.properties.find((p) => p.name.toLowerCase() === want);
    if (hit) return hit;
  }
  return null;
}

interface VertexLayout {
  x: PlyProperty; y: PlyProperty; z: PlyProperty;
  r: PlyProperty | null; g: PlyProperty | null; b: PlyProperty | null;
  /** A single-channel reading to fall back on when there is no rgb. */
  intensity: PlyProperty | null;
  /** The colour is a spherical harmonic DC term, not a plain channel. */
  harmonic: boolean;
}

function vertexLayout(el: PlyElement): VertexLayout {
  const x = find(el, ["x"]);
  const y = find(el, ["y"]);
  const z = find(el, ["z"]);
  if (!x || !y || !z) {
    throw new PlyError(
      "The vertex element has no x, y and z properties, so there are no "
      + "points to show.",
    );
  }

  let r = find(el, ["red", "r", "diffuse_red"]);
  let g = find(el, ["green", "g", "diffuse_green"]);
  let b = find(el, ["blue", "b", "diffuse_blue"]);
  let harmonic = false;

  // A Gaussian splat file, which is what Scaniverse's splat mode and most
  // splat trainers write. It is a perfectly ordinary PLY except that the
  // colour is the zeroth spherical harmonic coefficient rather than a channel,
  // so a reader looking only for `red` finds nothing and shows a grey cloud.
  // The positions are the splat centres, which is exactly the point cloud.
  if (!r || !g || !b) {
    const h0 = find(el, ["f_dc_0"]);
    const h1 = find(el, ["f_dc_1"]);
    const h2 = find(el, ["f_dc_2"]);
    if (h0 && h1 && h2) {
      r = h0; g = h1; b = h2;
      harmonic = true;
    }
  }

  return {
    x, y, z, r, g, b, harmonic,
    intensity: find(el, ["intensity", "scalar_intensity", "gray", "grey"]),
  };
}

/**
 * The band-zero spherical harmonic, as a colour.
 *
 * A splat's base colour is `0.5 + C0 * f_dc`, where C0 is the constant of the
 * zeroth real spherical harmonic, sqrt(1/(4*pi))/2. The result is 0 to 1 and
 * can land outside it, so it is clamped rather than allowed to wrap.
 */
const SH_C0 = 0.28209479177387814;
function harmonicToByte(v: number): number {
  const c = 0.5 + SH_C0 * v;
  return c <= 0 ? 0 : c >= 1 ? 255 : c * 255;
}

/** Colour channels are uchar 0-255 nearly always, but float 0-1 exists in the
 *  wild. One scale factor decided once beats a branch per channel per point. */
function colourScale(p: PlyProperty): number {
  switch (p.type) {
    case "uint8": case "int8": return 1;
    case "uint16": case "int16": return 255 / 65535;
    default: return 255;   // float channels are 0..1 by convention
  }
}

/* ----------------------------------------------------------------- reading */

export interface PlyCloud {
  /** 3 per point, float32, measured from `offset`. */
  positions: Float32Array;
  /** 3 per point, 0-255. Neutral grey when the file carried no colour. */
  colors: Uint8Array;
  count: number;
  /** Add this to a stored position to recover the file's own coordinate. */
  offset: [number, number, number];
  /** In stored space, so already relative to `offset`. */
  min: [number, number, number];
  max: [number, number, number];
  hasColor: boolean;
  encoding: PlyEncoding;
  comments: string[];
}

export type Progress = (fraction: number) => void;

const GREY = 0xb4;

/** Read one fixed-width scalar out of a record. */
function readScalar(
  view: DataView, at: number, type: ScalarType, le: boolean,
): number {
  switch (type) {
    case "int8": return view.getInt8(at);
    case "uint8": return view.getUint8(at);
    case "int16": return view.getInt16(at, le);
    case "uint16": return view.getUint16(at, le);
    case "int32": return view.getInt32(at, le);
    case "uint32": return view.getUint32(at, le);
    case "float32": return view.getFloat32(at, le);
    case "float64": return view.getFloat64(at, le);
  }
}

export function readPly(buffer: ArrayBuffer, onProgress?: Progress): PlyCloud {
  const bytes = new Uint8Array(buffer);
  const header = parseHeader(bytes);

  const vertexEl = header.elements.find((e) => e.name.toLowerCase() === "vertex");
  if (!vertexEl) throw new PlyError("This PLY file declares no vertex element.");
  if (vertexEl.count === 0) throw new PlyError("This PLY file contains no points.");

  const layout = vertexLayout(vertexEl);
  const n = vertexEl.count;

  // Allocated up front, because growing a 240 MB typed array by doubling costs
  // a second copy of it at the worst possible moment.
  let positions: Float32Array;
  let colors: Uint8Array;
  try {
    positions = new Float32Array(n * 3);
    colors = new Uint8Array(n * 3);
  } catch {
    throw new PlyError(
      `This scan has ${n.toLocaleString()} points, which is more than this `
      + `machine can hold. Export it decimated from the scanning app.`,
    );
  }

  const hasColor = !!(layout.r && layout.g && layout.b) || !!layout.intensity;
  if (!hasColor) colors.fill(GREY);

  const result = header.encoding === "ascii"
    ? readAscii(bytes, header, vertexEl, layout, positions, colors, onProgress)
    : readBinary(bytes, header, vertexEl, layout, positions, colors, onProgress);

  return {
    positions, colors, count: n,
    offset: result.offset, min: result.min, max: result.max,
    hasColor, encoding: header.encoding, comments: header.comments,
  };
}

interface Extent {
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
}

/* ------------------------------------------------------------------ binary */

function readBinary(
  bytes: Uint8Array,
  header: PlyHeader,
  vertexEl: PlyElement,
  layout: VertexLayout,
  positions: Float32Array,
  colors: Uint8Array,
  onProgress?: Progress,
): Extent {
  const le = header.encoding === "binary_little_endian";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Elements declared before `vertex` have to be walked past, not assumed away.
  let at = header.dataStart;
  for (const el of header.elements) {
    if (el === vertexEl) break;
    at = skipBinaryElement(view, at, el, le);
  }

  const stride = vertexEl.stride;
  if (stride === null) {
    throw new PlyError(
      "This file's vertex element contains a list property, which Snapir "
      + "Viewer does not read. Re-export the scan as a plain point cloud.",
    );
  }

  const n = vertexEl.count;
  const need = at + stride * n;
  if (need > bytes.length) {
    throw new PlyError(
      `The file ends early: the header promises ${n.toLocaleString()} points `
      + `but the file is ${(need - bytes.length).toLocaleString()} bytes short. `
      + `It is probably an incomplete copy.`,
    );
  }

  const { x: px, y: py, z: pz, r: pr, g: pg, b: pb, intensity: pi } = layout;
  const rs = pr ? colourScale(pr) : 0;
  const gs = pg ? colourScale(pg) : 0;
  const bs = pb ? colourScale(pb) : 0;
  const is = pi ? colourScale(pi) : 0;
  const rgb = !!(pr && pg && pb);

  let ox = 0, oy = 0, oz = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  // Reported about a hundred times over the whole file. Often enough that the
  // bar moves on a big scan, rarely enough that postMessage is not the cost.
  const step = Math.max(1, Math.floor(n / 100));

  for (let i = 0; i < n; i++) {
    const rec = at + i * stride;
    const vx = readScalar(view, rec + px.offset, px.type, le);
    const vy = readScalar(view, rec + py.offset, py.type, le);
    const vz = readScalar(view, rec + pz.offset, pz.type, le);

    if (i === 0) { ox = vx; oy = vy; oz = vz; }

    const rx = vx - ox, ry = vy - oy, rz = vz - oz;
    const o = i * 3;
    positions[o] = rx; positions[o + 1] = ry; positions[o + 2] = rz;

    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
    if (rz < minZ) minZ = rz; if (rz > maxZ) maxZ = rz;

    if (rgb && layout.harmonic) {
      colors[o] = harmonicToByte(readScalar(view, rec + pr!.offset, pr!.type, le));
      colors[o + 1] = harmonicToByte(readScalar(view, rec + pg!.offset, pg!.type, le));
      colors[o + 2] = harmonicToByte(readScalar(view, rec + pb!.offset, pb!.type, le));
    } else if (rgb) {
      colors[o] = readScalar(view, rec + pr!.offset, pr!.type, le) * rs;
      colors[o + 1] = readScalar(view, rec + pg!.offset, pg!.type, le) * gs;
      colors[o + 2] = readScalar(view, rec + pb!.offset, pb!.type, le) * bs;
    } else if (pi) {
      const v = readScalar(view, rec + pi.offset, pi.type, le) * is;
      colors[o] = v; colors[o + 1] = v; colors[o + 2] = v;
    }

    if (onProgress && i % step === 0) onProgress(i / n);
  }

  onProgress?.(1);
  return {
    offset: [ox, oy, oz],
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

/** Walk past one element's records without decoding them. */
function skipBinaryElement(
  view: DataView, at: number, el: PlyElement, le: boolean,
): number {
  if (el.stride !== null) return at + el.stride * el.count;
  for (let i = 0; i < el.count; i++) {
    for (const p of el.properties) {
      if (!p.list) { at += TYPE_SIZE[p.type]; continue; }
      const k = readScalar(view, at, p.countType!, le);
      at += TYPE_SIZE[p.countType!] + k * TYPE_SIZE[p.type];
    }
  }
  return at;
}

/* ------------------------------------------------------------------- ascii
   Walked as bytes rather than split into strings. A 20 million point ascii
   file is about a gigabyte, and `String.split` on that allocates a second
   gigabyte of string objects before a single number has been read. */

function readAscii(
  bytes: Uint8Array,
  header: PlyHeader,
  vertexEl: PlyElement,
  layout: VertexLayout,
  positions: Float32Array,
  colors: Uint8Array,
  onProgress?: Progress,
): Extent {
  let at = header.dataStart;

  // Skip whole lines for any element declared before the vertex one.
  for (const el of header.elements) {
    if (el === vertexEl) break;
    for (let i = 0; i < el.count; i++) at = nextLine(bytes, at);
  }

  const props = vertexEl.properties;
  // Which token index carries what. Faster than a name lookup per point, and
  // it is the same answer for every record in the file.
  const idx = (p: PlyProperty | null) => (p ? props.indexOf(p) : -1);
  const ix = idx(layout.x), iy = idx(layout.y), iz = idx(layout.z);
  const ir = idx(layout.r), ig = idx(layout.g), ib = idx(layout.b);
  const ii = idx(layout.intensity);
  const rgb = ir >= 0 && ig >= 0 && ib >= 0;

  const rs = layout.r ? colourScale(layout.r) : 0;
  const gs = layout.g ? colourScale(layout.g) : 0;
  const bs = layout.b ? colourScale(layout.b) : 0;
  const is = layout.intensity ? colourScale(layout.intensity) : 0;

  const wanted = Math.max(ix, iy, iz, ir, ig, ib, ii);
  const tokens = new Float64Array(wanted + 1);

  const n = vertexEl.count;
  let ox = 0, oy = 0, oz = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const step = Math.max(1, Math.floor(n / 100));

  for (let i = 0; i < n; i++) {
    if (at >= bytes.length) {
      throw new PlyError(
        `The file ends early: the header promises ${n.toLocaleString()} points `
        + `but only ${i.toLocaleString()} are written. It is probably an `
        + `incomplete copy.`,
      );
    }
    at = readLineNumbers(bytes, at, tokens, wanted + 1);

    const vx = tokens[ix], vy = tokens[iy], vz = tokens[iz];
    if (i === 0) { ox = vx; oy = vy; oz = vz; }

    const rx = vx - ox, ry = vy - oy, rz = vz - oz;
    const o = i * 3;
    positions[o] = rx; positions[o + 1] = ry; positions[o + 2] = rz;

    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
    if (rz < minZ) minZ = rz; if (rz > maxZ) maxZ = rz;

    if (rgb && layout.harmonic) {
      colors[o] = harmonicToByte(tokens[ir]);
      colors[o + 1] = harmonicToByte(tokens[ig]);
      colors[o + 2] = harmonicToByte(tokens[ib]);
    } else if (rgb) {
      colors[o] = tokens[ir] * rs;
      colors[o + 1] = tokens[ig] * gs;
      colors[o + 2] = tokens[ib] * bs;
    } else if (ii >= 0) {
      const v = tokens[ii] * is;
      colors[o] = v; colors[o + 1] = v; colors[o + 2] = v;
    }

    if (onProgress && i % step === 0) onProgress(i / n);
  }

  onProgress?.(1);
  return {
    offset: [ox, oy, oz],
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

function nextLine(bytes: Uint8Array, at: number): number {
  while (at < bytes.length && bytes[at] !== 0x0a) at++;
  return at + 1;
}

/**
 * Read up to `want` whitespace-separated numbers from one line into `out`,
 * and return the index of the start of the next line.
 *
 * Hand-rolled rather than `parseFloat` on a substring: the substring is the
 * expensive part, and at twenty million lines it is the whole runtime.
 */
function readLineNumbers(
  bytes: Uint8Array, at: number, out: Float64Array, want: number,
): number {
  let filled = 0;
  while (at < bytes.length) {
    const c = bytes[at];
    if (c === 0x0a) { at++; break; }
    if (c === 0x20 || c === 0x09 || c === 0x0d) { at++; continue; }

    let sign = 1;
    if (c === 0x2d) { sign = -1; at++; }          // '-'
    else if (c === 0x2b) { at++; }                // '+'

    let value = 0;
    while (at < bytes.length) {
      const d = bytes[at];
      if (d < 0x30 || d > 0x39) break;
      value = value * 10 + (d - 0x30);
      at++;
    }

    if (at < bytes.length && bytes[at] === 0x2e) {  // '.'
      at++;
      let frac = 0, scale = 1;
      while (at < bytes.length) {
        const d = bytes[at];
        if (d < 0x30 || d > 0x39) break;
        frac = frac * 10 + (d - 0x30);
        scale *= 10;
        at++;
      }
      value += frac / scale;
    }

    if (at < bytes.length && (bytes[at] === 0x65 || bytes[at] === 0x45)) {  // e/E
      at++;
      let esign = 1;
      if (bytes[at] === 0x2d) { esign = -1; at++; }
      else if (bytes[at] === 0x2b) { at++; }
      let exp = 0;
      while (at < bytes.length) {
        const d = bytes[at];
        if (d < 0x30 || d > 0x39) break;
        exp = exp * 10 + (d - 0x30);
        at++;
      }
      value *= 10 ** (esign * exp);
    }

    if (filled < want) out[filled] = sign * value;
    filled++;
  }

  // A short line leaves stale values behind, which would silently repeat the
  // previous point rather than showing that something is wrong.
  for (let i = filled; i < want; i++) out[i] = NaN;
  return at;
}

/* ---------------------------------------------------------------- shuffling
   Why a point cloud gets its order scrambled on the way in.

   Drawing fifty million points every frame is not something a mid-range card
   does at sixty hertz, so while the camera is moving the viewer draws only a
   prefix of the buffer. That is only honest if a prefix is a fair sample of
   the whole scan, and in file order it is the opposite: a scan is written in
   the order it was captured, so the first two million points are one corner
   of the room and the rest of the building simply vanishes while you turn.

   Shuffling once on import makes every prefix a uniform random sample, which
   costs one pass and no extra memory. An index buffer would avoid reordering
   but adds four bytes a point, which at fifty million is another 200 MB.

   Only raw imports are shuffled. A project stores its own order, and the
   indices in its deleted list and its measurements refer to that order, so
   reshuffling a reopened project would silently point them at other points. */

/** A cheap, well-distributed generator. `Math.random` fifty million times is
 *  a second of its own, and nothing here needs cryptographic quality. */
function xorshift(seed: number): () => number {
  let x = seed | 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over the two parallel arrays, in place. Colour travels with
 *  its own point: swapping one and not the other would repaint the scan. */
export function shuffleCloud(
  positions: Float32Array, colors: Uint8Array, count: number, seed = 0x5eed1e,
): void {
  const rnd = xorshift(seed);
  for (let i = count - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    if (i === j) continue;
    const a = i * 3, b = j * 3;

    let t = positions[a]; positions[a] = positions[b]; positions[b] = t;
    t = positions[a + 1]; positions[a + 1] = positions[b + 1]; positions[b + 1] = t;
    t = positions[a + 2]; positions[a + 2] = positions[b + 2]; positions[b + 2] = t;

    let u = colors[a]; colors[a] = colors[b]; colors[b] = u;
    u = colors[a + 1]; colors[a + 1] = colors[b + 1]; colors[b + 1] = u;
    u = colors[a + 2]; colors[a + 2] = colors[b + 2]; colors[b + 2] = u;
  }
}

/* ------------------------------------------------------------------ writing
   Binary little endian, x/y/z float32 and red/green/blue uchar. The one
   layout every tool reads, and the one this app's own export needs. */

export function writePly(
  positions: Float32Array,
  colors: Uint8Array,
  count: number,
  comments: string[] = [],
): Uint8Array {
  const head =
    "ply\n"
    + "format binary_little_endian 1.0\n"
    + comments.map((c) => `comment ${c}\n`).join("")
    + `element vertex ${count}\n`
    + "property float x\nproperty float y\nproperty float z\n"
    + "property uchar red\nproperty uchar green\nproperty uchar blue\n"
    + "end_header\n";

  const headBytes = new TextEncoder().encode(head);
  const STRIDE = 15;                       // 3 * 4 + 3 * 1
  const out = new Uint8Array(headBytes.length + count * STRIDE);
  out.set(headBytes, 0);

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let at = headBytes.length;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    view.setFloat32(at, positions[o], true);
    view.setFloat32(at + 4, positions[o + 1], true);
    view.setFloat32(at + 8, positions[o + 2], true);
    out[at + 12] = colors[o];
    out[at + 13] = colors[o + 1];
    out[at + 14] = colors[o + 2];
    at += STRIDE;
  }
  return out;
}
