/**
 * The checks that do not need a window.
 *
 * Reading a PLY, editing the cloud and writing a project are the three places
 * where a mistake is silent: the picture still looks like a room, and the
 * number on screen is simply wrong. So they are checked against a scan built
 * to a known size rather than against a screenshot.
 *
 *   npm run test            builds the fixtures and runs everything
 *
 * Run from the app directory. Fixtures land in tools/fixtures and are not
 * committed: they are regenerated from a fixed seed, so two machines produce
 * byte-identical files.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PointCloud } from "../src/cloud";
import { readPly, shuffleCloud, writePly } from "../src/ply";
import { looksLikeSvxp, readSvxp, writeSvxp } from "../src/svxp";
import { fromMetres } from "../src/units";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

/* ------------------------------------------------------------ the harness */

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${name}`); return; }
  failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
  console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
}

function near(name: string, got: number, want: number, tol: number) {
  const ok = Math.abs(got - want) <= tol;
  check(name, ok, ok ? "" : `got ${got}, wanted ${want} +/- ${tol}`);
}

function section(title: string) { console.log(`\n${title}`); }

/* ----------------------------------------------------------- the fixtures
   A room of exactly known size, so "4.000 m across" is a fact the test can
   assert rather than something eyeballed off a screenshot. */

const W = 4.0, H = 2.5, D = 3.2;
const STEP = 0.01;

let seed = 20260921;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

interface Pt { x: number; y: number; z: number; r: number; g: number; b: number }

function buildRoom(): Pt[] {
  const pts: Pt[] = [];
  const push = (x: number, y: number, z: number, r: number, g: number, b: number) =>
    pts.push({ x, y, z, r: r & 255, g: g & 255, b: b & 255 });

  // The six surfaces are built exactly on their planes. Noise would make the
  // extent assertion approximate for no gain: the parser is what is under
  // test, not the plausibility of the fixture.
  for (let x = 0; x <= W + 1e-9; x += STEP) {
    for (let z = 0; z <= D + 1e-9; z += STEP) {
      push(x, 0, z, 128, 116, 104);
      push(x, H, z, 230, 228, 222);
    }
  }
  for (let x = 0; x <= W + 1e-9; x += STEP) {
    for (let y = 0; y <= H + 1e-9; y += STEP) {
      push(x, y, 0, 206, 200, 188);
      push(x, y, D, 200, 196, 186);
    }
  }
  for (let z = 0; z <= D + 1e-9; z += STEP) {
    for (let y = 0; y <= H + 1e-9; y += STEP) {
      push(0, y, z, 198, 192, 182);
      push(W, y, z, 194, 190, 180);
    }
  }

  // One object standing in the middle of the room. Its radius is 0.19, so it
  // sits wholly inside BOX below with room to spare.
  for (let i = 0; i < 20000; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = 0.19 * Math.sqrt(rnd());
    push(2.0 + Math.cos(a) * rr, rnd() * 1.75, 1.6 + Math.sin(a) * rr, 40, 100, 190);
  }
  return pts;
}

/**
 * The box the selection test drags over.
 *
 * The bounds sit halfway between grid lines on purpose. On the boundary
 * itself, whether a wall point falls inside depends on float32 rounding and on
 * the drift in `x += STEP`, which would make the expected count a coin flip
 * rather than a fact.
 *
 * Note this box catches the floor and the ceiling under the object as well as
 * the object itself, which is exactly what a rectangle dragged over a scan
 * does. So the expected count is counted off the fixture with this same
 * predicate rather than assumed to be the object's own 20,000.
 */
const BOX = { x0: 1.805, x1: 2.195, z0: 1.405, z1: 1.795 };
const inBox = (x: number, z: number) =>
  x > BOX.x0 && x < BOX.x1 && z > BOX.z0 && z < BOX.z1;

function writeBinaryPly(file: string, pts: Pt[]) {
  const head = Buffer.from(
    "ply\nformat binary_little_endian 1.0\n"
    + "comment snapir viewer x self test fixture\n"
    + `element vertex ${pts.length}\n`
    + "property float x\nproperty float y\nproperty float z\n"
    + "property uchar red\nproperty uchar green\nproperty uchar blue\n"
    + "end_header\n", "ascii");
  const body = Buffer.allocUnsafe(pts.length * 15);
  let at = 0;
  for (const p of pts) {
    body.writeFloatLE(p.x, at); body.writeFloatLE(p.y, at + 4);
    body.writeFloatLE(p.z, at + 8);
    body[at + 12] = p.r; body[at + 13] = p.g; body[at + 14] = p.b;
    at += 15;
  }
  writeFileSync(file, Buffer.concat([head, body]));
}

function writeAsciiPly(file: string, pts: Pt[]) {
  const out: string[] = [
    "ply", "format ascii 1.0",
    `element vertex ${pts.length}`,
    "property float x", "property float y", "property float z",
    "property uchar red", "property uchar green", "property uchar blue",
    "end_header",
  ];
  for (const p of pts) {
    out.push(`${p.x.toFixed(6)} ${p.y.toFixed(6)} ${p.z.toFixed(6)} `
      + `${p.r} ${p.g} ${p.b}`);
  }
  writeFileSync(file, out.join("\n") + "\n");
}

/** A PLY with the property spellings a MeshLab round trip produces, plus a
 *  face element after the vertices, to prove both are handled. */
function writeAwkwardPly(file: string, pts: Pt[]) {
  const head = Buffer.from(
    "ply\nformat binary_little_endian 1.0\n"
    + `element vertex ${pts.length}\n`
    + "property double x\nproperty double y\nproperty double z\n"
    + "property uchar diffuse_red\nproperty uchar diffuse_green\n"
    + "property uchar diffuse_blue\nproperty uchar alpha\n"
    + "element face 2\nproperty list uchar int vertex_indices\n"
    + "end_header\n", "ascii");
  const stride = 8 * 3 + 4;
  const body = Buffer.allocUnsafe(pts.length * stride);
  let at = 0;
  for (const p of pts) {
    body.writeDoubleLE(p.x, at); body.writeDoubleLE(p.y, at + 8);
    body.writeDoubleLE(p.z, at + 16);
    body[at + 24] = p.r; body[at + 25] = p.g; body[at + 26] = p.b; body[at + 27] = 255;
    at += stride;
  }
  // Two triangles trailing the vertices, which must be skipped, not read.
  const faces = Buffer.alloc(2 * (1 + 12));
  let f = 0;
  for (let i = 0; i < 2; i++) {
    faces[f] = 3;
    faces.writeInt32LE(0, f + 1);
    faces.writeInt32LE(1, f + 5);
    faces.writeInt32LE(2, f + 9);
    f += 13;
  }
  writeFileSync(file, Buffer.concat([head, body, faces]));
}

/**
 * A Gaussian splat file, which is what Scaniverse's splat mode writes. Same
 * PLY container, but the colour is the zeroth spherical harmonic coefficient
 * and there is no `red` property anywhere, plus the pile of extra per-splat
 * properties a reader has to step over to find the next point.
 */
function writeSplatPly(file: string, pts: Pt[]) {
  const props = [
    "x", "y", "z", "nx", "ny", "nz",
    "f_dc_0", "f_dc_1", "f_dc_2",
    "opacity", "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
  ];
  const head = Buffer.from(
    "ply\nformat binary_little_endian 1.0\n"
    + `element vertex ${pts.length}\n`
    + props.map((p) => `property float ${p}\n`).join("")
    + "end_header\n", "ascii");

  const stride = props.length * 4;
  const body = Buffer.allocUnsafe(pts.length * stride);
  let at = 0;
  // Inverse of the reader's transform, so a known byte comes back as itself.
  const toHarmonic = (byte: number) => ((byte / 255) - 0.5) / 0.28209479177387814;
  for (const p of pts) {
    body.writeFloatLE(p.x, at); body.writeFloatLE(p.y, at + 4);
    body.writeFloatLE(p.z, at + 8);
    body.writeFloatLE(0, at + 12); body.writeFloatLE(1, at + 16);
    body.writeFloatLE(0, at + 20);
    body.writeFloatLE(toHarmonic(p.r), at + 24);
    body.writeFloatLE(toHarmonic(p.g), at + 28);
    body.writeFloatLE(toHarmonic(p.b), at + 32);
    for (let k = 36; k < stride; k += 4) body.writeFloatLE(0, at + k);
    at += stride;
  }
  writeFileSync(file, Buffer.concat([head, body]));
}

/** A handful of points spread along x, for the bounds-cache checks. */
function makeCloudForBounds(): PointCloud {
  const n = 1000;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions[i * 3] = i / (n - 1);
  return new PointCloud({
    positions,
    colors: new Uint8Array(n * 3).fill(180),
    count: n,
    offset: [0, 0, 0], min: [0, 0, 0], max: [1, 0, 0], hasColor: true,
    sourceUnit: "m",
    source: { name: "bounds", ref: "x", originalCount: n, encoding: "test", comments: [] },
  });
}

/* -------------------------------------------------------------- the tests */

function main() {
  mkdirSync(FIXTURES, { recursive: true });

  const pts = buildRoom();
  const binary = join(FIXTURES, "room.ply");
  const ascii = join(FIXTURES, "room-ascii.ply");
  const awkward = join(FIXTURES, "room-awkward.ply");

  if (!existsSync(binary)) writeBinaryPly(binary, pts);
  if (!existsSync(ascii)) writeAsciiPly(ascii, pts.filter((_, i) => i % 20 === 0));
  if (!existsSync(awkward)) writeAwkwardPly(awkward, pts.filter((_, i) => i % 20 === 0));

  console.log(`fixture: ${pts.length.toLocaleString()} points, `
    + `${(statSync(binary).size / 1e6).toFixed(1)} MB`);

  const toArrayBuffer = (f: string) => {
    const b = readFileSync(f);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };

  /* ---------------------------------------------------------- binary read */
  section("binary little endian");
  const t0 = Date.now();
  const bin = readPly(toArrayBuffer(binary));
  const readMs = Date.now() - t0;
  check("point count matches the header", bin.count === pts.length,
    `${bin.count} vs ${pts.length}`);
  check("colour was found", bin.hasColor);
  near("width", bin.max[0] - bin.min[0], W, 1e-4);
  near("height", bin.max[1] - bin.min[1], H, 1e-4);
  near("depth", bin.max[2] - bin.min[2], D, 1e-4);
  check("comments survived", bin.comments.some((c) => c.includes("self test")));
  console.log(`  (${readMs} ms, `
    + `${Math.round(bin.count / Math.max(readMs, 1) / 1000)}M points/s)`);

  // The first point is the origin the rest are measured from, so it has to
  // read back as exactly zero.
  check("first point is the origin",
    bin.positions[0] === 0 && bin.positions[1] === 0 && bin.positions[2] === 0);

  /* ----------------------------------------------------------- ascii read */
  section("ascii");
  const asc = readPly(toArrayBuffer(ascii));
  near("width", asc.max[0] - asc.min[0], W, 1e-3);
  near("height", asc.max[1] - asc.min[1], H, 1e-3);
  near("depth", asc.max[2] - asc.min[2], D, 1e-3);
  check("colour was found", asc.hasColor);

  /* ------------------------------------------- doubles, aliases and faces */
  section("double coordinates, diffuse_ colour names, trailing faces");
  const awk = readPly(toArrayBuffer(awkward));
  check("point count is the vertex count, not the face count",
    awk.count === Math.ceil(pts.length / 20),
    `${awk.count} vs ${Math.ceil(pts.length / 20)}`);
  check("diffuse_red was recognised as colour", awk.hasColor);
  near("width", awk.max[0] - awk.min[0], W, 1e-3);

  /* ---------------------------------------------- gaussian splat colour */
  section("gaussian splat colour (Scaniverse splat mode)");
  const splatFile = join(FIXTURES, "room-splat.ply");
  const splatPts = pts.filter((_, i) => i % 20 === 0);
  if (!existsSync(splatFile)) writeSplatPly(splatFile, splatPts);
  const splat = readPly(toArrayBuffer(splatFile));
  check("splat point count", splat.count === splatPts.length,
    `${splat.count} vs ${splatPts.length}`);
  check("a splat file is not reported as colourless", splat.hasColor);
  near("width is still the room", splat.max[0] - splat.min[0], W, 1e-3);
  // Within one byte: the harmonic round trip goes through a float32.
  const dr = Math.abs(splat.colors[0] - splatPts[0].r);
  const dg = Math.abs(splat.colors[1] - splatPts[0].g);
  const db = Math.abs(splat.colors[2] - splatPts[0].b);
  check("harmonic colour decodes back to the original bytes",
    dr <= 1 && dg <= 1 && db <= 1,
    `got ${splat.colors[0]},${splat.colors[1]},${splat.colors[2]} `
    + `wanted ${splatPts[0].r},${splatPts[0].g},${splatPts[0].b}`);

  /* ------------------------------------------------------------- shuffling
     The decimation while the camera moves draws a prefix of the buffer, which
     is only a fair sample because the buffer was scrambled on import. Two
     things have to hold: no point may be invented or lost, and every point
     must keep its own colour. */
  section("import shuffle");
  {
    const n = 40000;
    const pos = new Float32Array(n * 3);
    const col = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      // Colour derived from position, so a mismatch after shuffling is
      // detectable point by point rather than only in aggregate.
      pos[i * 3] = i; pos[i * 3 + 1] = i * 2; pos[i * 3 + 2] = i * 3;
      col[i * 3] = i & 255; col[i * 3 + 1] = (i >> 8) & 255; col[i * 3 + 2] = 7;
    }

    shuffleCloud(pos, col, n);

    let moved = 0, mismatched = 0;
    const seen = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const id = pos[i * 3];
      if (id !== i) moved++;
      if (!Number.isInteger(id) || id < 0 || id >= n) { mismatched++; continue; }
      seen[id] = 1;
      if (pos[i * 3 + 1] !== id * 2 || pos[i * 3 + 2] !== id * 3) mismatched++;
      if (col[i * 3] !== (id & 255) || col[i * 3 + 1] !== ((id >> 8) & 255)
        || col[i * 3 + 2] !== 7) mismatched++;
    }
    check("every point survived exactly once",
      seen.every((v) => v === 1), `${seen.filter((v) => !v).length} missing`);
    check("colour stayed with its own point", mismatched === 0,
      `${mismatched} mismatched`);
    check("the order actually changed", moved > n * 0.9, `${moved} of ${n} moved`);

    // Deterministic, so two machines produce the same file and a fixture
    // regenerated tomorrow is the same fixture.
    const pos2 = new Float32Array(n * 3);
    const col2 = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos2[i * 3] = i; pos2[i * 3 + 1] = i * 2; pos2[i * 3 + 2] = i * 3;
      col2[i * 3] = i & 255; col2[i * 3 + 1] = (i >> 8) & 255; col2[i * 3 + 2] = 7;
    }
    shuffleCloud(pos2, col2, n);
    check("the shuffle is deterministic", pos2.every((v, i) => v === pos[i]));
  }

  /* --------------------------------------------------------- bounds cache
     The box is cached against the geometry and not against the revision,
     because a marquee drag changes the revision hundreds of times and can
     never move a point. Getting this wrong is invisible: the number on
     screen is right, and the scan is walked twice for every selection. */
  section("bounds cache");
  {
    const c = makeCloudForBounds();
    const first = c.liveBounds()!;
    c.selectWhere((x) => x > 0.5);
    const afterSelect = c.liveBounds()!;
    check("selecting returns the identical cached object",
      afterSelect === first);

    c.deleteSelected();
    const afterDelete = c.liveBounds()!;
    check("deleting recomputes the box", afterDelete !== first);
    check("and the box actually shrank", afterDelete.max[0] < first.max[0],
      `${afterDelete.max[0]} vs ${first.max[0]}`);

    c.undo();
    check("undo recomputes it again", c.liveBounds()!.max[0] === first.max[0]);
  }

  /* ------------------------------------------------------------- picking
     Against a hand-built clip matrix rather than a camera, so the expected
     answer is arithmetic instead of a screenshot. The matrix maps clip.x to x,
     clip.y to y and clip.w to z + 1, so a point's screen position is
     (x/(z+1), y/(z+1)) and its depth is z + 1. */
  section("picking under the cursor");

  const clip = new Float32Array(16);
  clip[0] = 1;                      // row 0 -> clip.x = x
  clip[5] = 1;                      // row 1 -> clip.y = y
  clip[11] = 1; clip[15] = 1;       // row 3 -> clip.w = z + 1

  const makeCloud = (xyz: number[]) => new PointCloud({
    positions: new Float32Array(xyz),
    colors: new Uint8Array(xyz.length).fill(200),
    count: xyz.length / 3,
    offset: [0, 0, 0], min: [0, 0, 0], max: [1, 1, 1], hasColor: true,
    sourceUnit: "m",
    source: { name: "pick", ref: "x", originalCount: xyz.length / 3,
      encoding: "test", comments: [] },
  });

  // A patch of a near surface whose corner is exactly at the cursor, plus
  // points running away from it. The corner is what was being missed.
  const patch: number[] = [];
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) patch.push(i * 0.004, j * 0.004, 0);
  }
  const cornerCloud = makeCloud(patch);
  const hit = cornerCloud.pickNearest(clip, 0, 0, 500, 500, 14);
  check("the corner under the cursor is the point returned", hit === 0,
    `index ${hit} at ${hit == null ? "-" : cornerCloud.pointAt(hit).join(",")}`);

  // The same patch, plus a point on a far surface sitting exactly under the
  // cursor. It is closer on screen, and it must still lose: snapping a
  // measurement through a wall is wrong in a way nothing on screen shows.
  const throughWall = makeCloud([
    0, 0, 5,            // dead under the cursor, but five units back
    0.004, 0.004, 0,    // two pixels away on the near surface
    0.02, 0.02, 0,
  ]);
  const hit2 = throughWall.pickNearest(clip, 0, 0, 500, 500, 14);
  check("a point on the wall behind never wins", hit2 === 1,
    `index ${hit2}`);

  // Nothing within the radius is not a pick.
  const empty = makeCloud([0.5, 0.5, 0]);
  check("an empty patch of sky returns nothing",
    empty.pickNearest(clip, 0, 0, 500, 500, 14) === null);

  // A deleted point is not pickable, or a measurement could be taken between
  // two points that are no longer in the scan.
  // The survivor sits at 0.01, 0.01, which is 7.1 pixels from the cursor at
  // this scale and so comfortably inside the radius. At 0.02 it would be
  // 14.1 pixels out and the test would be checking the radius, not deletion.
  const gone = makeCloud([0, 0, 0, 0.01, 0.01, 0]);
  gone.selectWhere((x) => x === 0);
  gone.deleteSelected();
  check("a deleted point cannot be picked",
    gone.pickNearest(clip, 0, 0, 500, 500, 14) === 1);

  /* --------------------------------------------------------- the editing */
  section("selection, delete, undo, redo");
  const cloud = new PointCloud({
    positions: bin.positions, colors: bin.colors, count: bin.count,
    offset: bin.offset, min: bin.min, max: bin.max, hasColor: bin.hasColor,
    sourceUnit: "m",
    source: {
      name: "room", ref: binary, originalCount: bin.count,
      encoding: bin.encoding, comments: bin.comments,
    },
  });

  const total = cloud.count;
  // Ground truth from the fixture itself, under the same predicate. Counting
  // it here rather than writing a number down is what caught that the box
  // takes the floor and the ceiling with it, which is correct behaviour.
  const expected = pts.filter((p) => inBox(p.x, p.z)).length;
  check("the box is not trivially empty or everything",
    expected > 20000 && expected < total / 4, `${expected}`);

  const selected = cloud.selectWhere((x, _y, z) => inBox(x, z));
  check("selection matches the fixture", selected === expected,
    `selected ${selected}, fixture holds ${expected}`);
  check("selection count agrees", cloud.selection === expected);

  const removed = cloud.deleteSelected();
  check("delete removed exactly the selection", removed === expected);
  check("visible count dropped by the same", cloud.visibleCount === total - expected);
  check("selection is empty after a delete", cloud.selection === 0);
  check("undo is available", cloud.canUndo);

  const ext = cloud.extent()!;
  near("room is still 4.000 m wide after the cut", ext.size[0], W, 1e-4);
  near("room is still 2.500 m tall after the cut", ext.size[1], H, 1e-4);

  cloud.undo();
  check("undo put every point back", cloud.visibleCount === total);
  check("redo is available", cloud.canRedo);
  cloud.redo();
  check("redo took them away again", cloud.visibleCount === total - expected);

  // A fresh edit has to invalidate the redo branch, or a later redo would
  // restore points this edit never touched.
  cloud.undo();
  cloud.selectWhere((x) => x < 0.05);
  cloud.deleteSelected();
  check("a new edit clears the redo stack", !cloud.canRedo);
  cloud.undo();
  check("back to the whole room", cloud.visibleCount === total);

  /* ------------------------------------------------------------ distance */
  section("measurement");
  // Two points built exactly on opposite walls at the same height and depth.
  let a = -1, b = -1;
  for (let i = 0; i < cloud.count && (a < 0 || b < 0); i++) {
    const p = cloud.pointAt(i);
    const onFloorLine = Math.abs(p[1] - bin.min[1]) < 1e-6
      && Math.abs(p[2] - bin.min[2]) < 1e-6;
    if (!onFloorLine) continue;
    if (a < 0 && Math.abs(p[0] - bin.min[0]) < 1e-6) a = i;
    if (b < 0 && Math.abs(p[0] - bin.max[0]) < 1e-6) b = i;
  }
  check("found two points on opposite walls", a >= 0 && b >= 0);
  if (a >= 0 && b >= 0) {
    near("distance across the room in metres", cloud.distance(a, b), W, 1e-4);
    cloud.sourceUnit = "mm";
    near("the same scan read as millimetres", cloud.distance(a, b), W / 1000, 1e-7);
    cloud.sourceUnit = "m";
  }
  near("4 m expressed in inches", fromMetres(4, "in"), 157.48031, 1e-4);
  near("4 m expressed in feet", fromMetres(4, "ft"), 13.12336, 1e-4);

  /* ------------------------------------------------------- ply round trip */
  section("cleaned .ply export");
  cloud.selectWhere((x, _y, z) => inBox(x, z));
  cloud.deleteSelected();
  const packed = cloud.compact();
  check("compact drops the deleted points", packed.count === total - expected);

  const written = writePly(packed.positions, packed.colors, packed.count, ["round trip"]);
  const reread = readPly(
    written.buffer.slice(written.byteOffset,
      written.byteOffset + written.byteLength) as ArrayBuffer);
  check("written file reads back with the same count", reread.count === packed.count);
  const rext = Math.abs((reread.max[0] - reread.min[0]) - W);
  check("written file has the same width", rext < 1e-4, `off by ${rext}`);
  check("colour survived the round trip",
    reread.colors[0] === packed.colors[0]
    && reread.colors[1] === packed.colors[1]
    && reread.colors[2] === packed.colors[2]);

  /* ------------------------------------------------------ svxp round trip */
  section(".svxp project round trip");
  const measurements = [
    { id: "m1", a: 0, b: 10, metres: cloud.distance(0, 10), name: "Across" },
  ];
  const project = writeSvxp(cloud, {
    measurements,
    view: { displayUnit: "cm", pointSize: 3, background: "dark" },
    appVersion: "test",
  });
  check("a project is recognisable as one",
    looksLikeSvxp(project.buffer.slice(
      project.byteOffset, project.byteOffset + project.byteLength) as ArrayBuffer));

  const back = readSvxp(project.buffer.slice(
    project.byteOffset, project.byteOffset + project.byteLength) as ArrayBuffer);
  check("every point is still in the project, deleted ones included",
    back.count === total, `${back.count} vs ${total}`);
  check("the deleted list survived", back.deleted?.length === expected,
    `${back.deleted?.length} vs ${expected}`);
  check("measurements survived", back.measurements.length === 1);
  check("the view settings survived", back.view.displayUnit === "cm"
    && back.view.pointSize === 3);
  check("the source unit survived", back.manifest.scan.sourceUnit === "m");

  const reopened = new PointCloud({
    positions: back.positions, colors: back.colors, count: back.count,
    offset: back.manifest.scan.offset,
    min: back.manifest.scan.min, max: back.manifest.scan.max,
    hasColor: back.manifest.scan.hasColor,
    sourceUnit: back.manifest.scan.sourceUnit,
    source: {
      name: "reopened", ref: "x", originalCount: back.count,
      encoding: back.manifest.scan.sourceEncoding, comments: [],
    },
    deleted: back.deleted || undefined,
  });
  check("the reopened project hides the same points",
    reopened.visibleCount === total - expected,
    `${reopened.visibleCount} vs ${total - expected}`);
  near("and still measures 4.000 m across", reopened.extent()!.size[0], W, 1e-4);
  check("restoring puts the cut points back",
    reopened.restoreAll() === expected && reopened.visibleCount === total);

  /* ------------------------------------------------------- bad input */
  section("files that are not what they claim");
  const notPly = new TextEncoder().encode("this is not a point cloud at all");
  let threw = "";
  try {
    readPly(notPly.buffer.slice(0, notPly.byteLength) as ArrayBuffer);
  } catch (e) { threw = String((e as Error).message); }
  check("a text file is refused with a sentence",
    threw.includes("not a PLY file"), threw);

  // A header that promises more points than the file holds is the commonest
  // real failure: a copy that was interrupted.
  const truncated = readFileSync(binary).subarray(0, 4000);
  threw = "";
  try {
    readPly(truncated.buffer.slice(
      truncated.byteOffset, truncated.byteOffset + truncated.byteLength) as ArrayBuffer);
  } catch (e) { threw = String((e as Error).message); }
  check("a truncated file says so", threw.includes("ends early"), threw);

  /* ------------------------------------------------------------- verdict */
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();
