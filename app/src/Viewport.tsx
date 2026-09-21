/**
 * The 3D viewport.
 *
 * One `THREE.Points` holding the whole scan, drawn in one call, plus the
 * measurement lines on top of it. There is no level of detail and no streaming:
 * the cloud is uploaded once and the GPU draws all of it every frame, which is
 * the right trade at the sizes this app promises and is the reason a delete
 * costs a one-byte-per-point upload instead of rebuilding a buffer.
 *
 * Three things deserve their own note.
 *
 * State lives in a vertex attribute, not in the geometry. Deleting points by
 * rewriting the position buffer would mean re-uploading hundreds of megabytes
 * on every cut and would make undo a re-parse. Instead each point carries one
 * byte, the vertex shader throws deleted points out of the clip volume, and an
 * edit uploads that one byte per point.
 *
 * Colour is converted from sRGB to linear in the shader. Scanner colour comes
 * from the camera and is sRGB-encoded; three.js converts the framebuffer back
 * to sRGB on output. Skipping the first half of that round trip is what makes
 * every AI-built point cloud viewer look washed out.
 *
 * Motion is almost absent on purpose. Orbiting, selecting and deleting happen
 * hundreds of times an hour, and animating any of them would put a delay
 * between the operator and the thing they are pointing at. The one animated
 * thing is the camera move on Fit, which is rare and needs the continuity.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { type Measurement, type PointCloud } from "./cloud";
import { formatWithUnit, type Unit } from "./units";

export type Tool = "orbit" | "select" | "measure";
export type SelectMode = "replace" | "add" | "subtract";
export type UpAxis = "y" | "z";
/** Looking at the scan from outside it, or standing in it. */
export type ViewMode = "outside" | "inside";

/* ------------------------------------------------- standing in the scan
   The same numbers Snapir Design X walks a solved room with, so moving
   between the two applications does not mean relearning the speed of your
   own feet. Both are metres and are converted into the scan's own units
   before anything uses them, because a scan measured in millimetres would
   otherwise take an hour to cross. */
const EYE_METRES = 1.6;      // eye height of someone standing
const SPEED_METRES = 2.4;    // an unhurried walk, not a sprint
const LOOK_RATE = 0.0032;    // radians per pixel dragged
const PITCH_LIMIT = 1.35;    // just short of straight up or straight down

const GOLD = "#A87A26";
const GOLD_BRIGHT = "#C99B3F";

export interface ViewportProps {
  cloud: PointCloud | null;
  /** Bumped by the owner whenever the cloud's state bytes changed. */
  revision: number;
  tool: Tool;
  view: ViewMode;
  pointSize: number;
  /** Points shrink with distance instead of staying a fixed size on screen. */
  attenuate: boolean;
  dark: boolean;
  upAxis: UpAxis;
  measurements: Measurement[];
  selectedMeasurement: string | null;
  displayUnit: Unit;
  /** The first end of a measurement, waiting for its second. */
  pendingPoint: number | null;
  /** Bumped by the owner to re-frame the camera on what is left. */
  fitSignal: number;
  /** The rectangle, how it combines with what is already selected, and the
   *  object-to-clip matrix the owner needs to run the test. The matrix only
   *  exists inside the rig and only for this frame, so it is handed over
   *  rather than fetched. */
  onRectSelect: (rect: RectNdc, mode: SelectMode, clip: Float32Array) => void;
  onPickPoint: (index: number | null) => void;
  onPickMeasurement: (id: string | null) => void;
  /** Handed a function that renders a thumbnail of the current view. */
  thumbnailHandle?: React.MutableRefObject<(() => Promise<Uint8Array | null>) | null>;
}

export interface RectNdc { x0: number; x1: number; y0: number; y1: number }

/* --------------------------------------------------------------- shaders */

const VERTEX = /* glsl */ `
attribute vec3 acolor;
attribute float astate;

uniform float uSize;
uniform float uPixelRatio;
uniform float uAttenuate;
uniform vec3  uSelected;

varying vec3 vColor;

// The exact piecewise sRGB transfer function, not pow(c, 2.2). The two differ
// most in the darkest few percent, which on a scan is the shadowed half of
// every room.
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

void main() {
  float deleted  = mod(astate, 2.0);
  float selected = mod(floor(astate / 2.0), 2.0);

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  // Thrown clear of the clip volume rather than merely sized to nothing: a
  // zero point size is a driver-dependent promise and this is not.
  if (deleted > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    return;
  }

  vColor = mix(srgbToLinear(acolor), uSelected, selected);

  float size = uSize * uPixelRatio;
  // -mv.z is view-space depth. Guarded because a point exactly on the eye
  // would otherwise take the size to infinity and paint the whole screen.
  gl_PointSize = mix(size, size * 300.0 / max(-mv.z, 0.001), uAttenuate);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform float uRound;
varying vec3 vColor;

void main() {
  // Square points below about four pixels: the discard that makes them round
  // costs early-z for every one of twenty million, and at three pixels nobody
  // can tell. Above that the corners are visible and worth paying for.
  if (uRound > 0.5) {
    vec2 d = gl_PointCoord - vec2(0.5);
    if (dot(d, d) > 0.25) discard;
  }
  gl_FragColor = vec4(vColor, 1.0);
}
`;

/* ------------------------------------------------------------------ scene */

interface Rig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Holds the cloud, and carries the up-axis correction. */
  pivot: THREE.Group;
  points: THREE.Points | null;
  material: THREE.ShaderMaterial | null;
  stateAttr: THREE.BufferAttribute | null;
  lines: THREE.Group;
  labels: HTMLDivElement;
  /** Object-to-clip, rebuilt each time it is needed rather than cached. */
  clip: THREE.Matrix4;
  raf: number;
  needsRender: boolean;

  /* standing in the scan */
  inside: boolean;
  yaw: number;
  pitch: number;
  keys: Set<string>;
  /** Timestamp of the previous frame, so walking is a speed and not a speed
   *  per frame: the same stride on a 60 Hz panel and a 144 Hz one. */
  lastFrame: number;
  /** World Y of the floor, and the two rates in the scan's own units. */
  floorY: number;
  eyeHeight: number;
  speed: number;
}

export default function Viewport(props: ViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<Rig | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  /** The drag rectangle, in CSS pixels relative to the host. */
  const dragRef = useRef<{ x: number; y: number; mode: SelectMode } | null>(null);
  const rectElRef = useRef<HTMLDivElement>(null);
  /** Where the look-drag was last frame, while standing in the scan. */
  const lookRef = useRef<{ x: number; y: number } | null>(null);

  /* ----------------------------------------------------------- one-time */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: false,           // points do not benefit; the fill cost does
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 10_000);
    camera.position.set(3, 3, 3);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;   // enough to feel connected, not floaty
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;

    const pivot = new THREE.Group();
    scene.add(pivot);

    const lines = new THREE.Group();
    pivot.add(lines);

    const labels = document.createElement("div");
    labels.className = "labels";
    host.appendChild(labels);

    // Yaw then pitch, which is what a head does. The default XYZ order rolls
    // the horizon as soon as you look up and turn at the same time.
    camera.rotation.order = "YXZ";

    const rig: Rig = {
      renderer, scene, camera, controls, pivot,
      points: null, material: null, stateAttr: null,
      lines, labels, clip: new THREE.Matrix4(), raf: 0, needsRender: true,
      inside: false, yaw: 0, pitch: 0, keys: new Set(),
      lastFrame: 0, floorY: 0, eyeHeight: 1.6, speed: 2.4,
    };
    rigRef.current = rig;

    // Held on the window rather than the canvas so that walking does not stop
    // the moment the pointer leaves the viewport, and cleared on blur because
    // a window that loses focus mid-stride would otherwise walk for ever.
    const down = (e: KeyboardEvent) => {
      if (!rig.inside) return;
      const k = e.key.toLowerCase();
      if ("wasdqe".includes(k) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.isContentEditable)) return;
        rig.keys.add(k);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => rig.keys.delete(e.key.toLowerCase());
    const blur = () => rig.keys.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      rig.lines.traverse((o) => {
        const m = (o as Line2).material as LineMaterial | undefined;
        if (m?.isLineMaterial) m.resolution.set(w, h);
      });
      rig.needsRender = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    controls.addEventListener("change", () => { rig.needsRender = true; });

    // Rendered on demand rather than at a constant sixty. A viewer sits open
    // and untouched for minutes at a time, and a laptop should not spend its
    // battery redrawing a still picture of twenty million points.
    const loop = (now: number) => {
      rig.raf = requestAnimationFrame(loop);

      // Clamped, because a tab that was in the background for ten seconds
      // would otherwise deliver one frame worth ten seconds of walking and
      // put the eye through the far wall.
      const dt = rig.lastFrame ? Math.min((now - rig.lastFrame) / 1000, 0.1) : 0;
      rig.lastFrame = now;

      // OrbitControls is left disabled while inside, so its damping cannot
      // fight the walk for the camera.
      const moved = rig.inside ? walk(rig, dt) : controls.update();
      if (moved || rig.needsRender) {
        // Before the render, not after. The end markers are unit spheres sized
        // from the camera distance here, so scaling them after drawing left
        // the frame they first appeared on showing a one-metre ball, and
        // because the loop only draws on demand there was no second frame to
        // correct it.
        syncOverlay(rig, propsRef.current);
        renderer.render(scene, camera);
        rig.needsRender = false;
      }
    };
    rig.raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rig.raf);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      ro.disconnect();
      controls.dispose();
      disposeCloud(rig);
      rig.lines.traverse((o) => {
        const l = o as Line2;
        l.geometry?.dispose?.();
        (l.material as LineMaterial)?.dispose?.();
      });
      renderer.dispose();
      labels.remove();
      renderer.domElement.remove();
      rigRef.current = null;
    };
  }, []);

  /* ------------------------------------------------------------- the cloud */
  useEffect(() => {
    const rig = rigRef.current;
    if (!rig) return;
    disposeCloud(rig);
    if (!props.cloud) { rig.needsRender = true; return; }

    const cloud = props.cloud;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position",
      new THREE.BufferAttribute(cloud.positions, 3));
    geometry.setAttribute("acolor",
      new THREE.BufferAttribute(cloud.colors, 3, true));

    const stateAttr = new THREE.BufferAttribute(cloud.state, 1, false);
    stateAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("astate", stateAttr);

    // Set rather than computed. three.js would walk every one of twenty
    // million positions to find what the parser already measured.
    const cx = (cloud.min[0] + cloud.max[0]) / 2;
    const cy = (cloud.min[1] + cloud.max[1]) / 2;
    const cz = (cloud.min[2] + cloud.max[2]) / 2;
    const radius = Math.hypot(
      cloud.max[0] - cx, cloud.max[1] - cy, cloud.max[2] - cz) || 1;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), radius);

    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uSize: { value: props.pointSize },
        uPixelRatio: { value: rig.renderer.getPixelRatio() },
        uAttenuate: { value: props.attenuate ? 1 : 0 },
        uRound: { value: props.pointSize >= 4 ? 1 : 0 },
        uSelected: { value: new THREE.Color(GOLD) },
      },
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;   // one object, always partly on screen
    rig.pivot.add(points);
    rig.points = points;
    rig.material = material;
    rig.stateAttr = stateAttr;

    frameCloud(rig, cloud, false);
    rig.needsRender = true;
  }, [props.cloud]);

  /* ------------------------------------------ state bytes changed on the CPU */
  useEffect(() => {
    const rig = rigRef.current;
    if (!rig?.stateAttr) return;
    rig.stateAttr.needsUpdate = true;
    rig.needsRender = true;
  }, [props.revision]);

  /* ------------------------------------------------------------ appearance */
  useEffect(() => {
    const rig = rigRef.current;
    if (!rig?.material) return;
    rig.material.uniforms.uSize.value = props.pointSize;
    rig.material.uniforms.uRound.value = props.pointSize >= 4 ? 1 : 0;
    rig.material.uniforms.uAttenuate.value = props.attenuate ? 1 : 0;
    rig.needsRender = true;
  }, [props.pointSize, props.attenuate]);

  useEffect(() => {
    const rig = rigRef.current;
    if (!rig) return;
    // Matches --vp-a / --vp-b in the stylesheet, flat rather than a gradient:
    // a gradient behind a point cloud reads as haze in the geometry.
    rig.scene.background = new THREE.Color(props.dark ? "#1A1A1D" : "#EDEDE8");
    rig.needsRender = true;
  }, [props.dark]);

  useEffect(() => {
    const rig = rigRef.current;
    if (!rig) return;
    // ARKit hands back a Y-up frame and most phone scanners write it straight
    // out; anything that came through survey software is Z-up. One rotation on
    // the pivot puts either of them the right way up without touching a point.
    rig.pivot.rotation.set(props.upAxis === "z" ? -Math.PI / 2 : 0, 0, 0);
    rig.needsRender = true;
  }, [props.upAxis]);

  /* --------------------------------------------------- standing in the scan */
  useEffect(() => {
    const rig = rigRef.current;
    if (!rig) return;
    const wantInside = props.view === "inside" && !!props.cloud;
    if (wantInside === rig.inside) return;

    rig.inside = wantInside;
    rig.keys.clear();

    if (!wantInside) {
      rig.controls.enabled = true;
      // Back out to where the whole scan is visible, rather than leaving the
      // camera buried in a wall with the orbit target somewhere behind it.
      if (props.cloud) frameCloud(rig, props.cloud, false);
      rig.needsRender = true;
      return;
    }

    rig.controls.enabled = false;
    standInside(rig, props.cloud!);
    rig.needsRender = true;
  }, [props.view, props.cloud]);

  /* ------------------------------------------------------------------- fit */
  useEffect(() => {
    const rig = rigRef.current;
    if (!rig || !props.cloud || props.fitSignal === 0) return;
    // Inside, there is no framing to do. Fit is the way back to the middle of
    // the room after walking into a corner, which is the same thing the
    // button means outside: put me where I can see.
    if (rig.inside) standInside(rig, props.cloud);
    else frameCloud(rig, props.cloud, true);
  }, [props.fitSignal]);

  /* ---------------------------------------------------------- measurements */
  useEffect(() => {
    const rig = rigRef.current;
    if (!rig || !props.cloud) return;
    rebuildMeasurements(rig, props);
    rig.needsRender = true;
  }, [props.measurements, props.selectedMeasurement, props.pendingPoint,
      props.displayUnit, props.dark, props.cloud]);

  /* ------------------------------------------------------------ input mode */
  useEffect(() => {
    const rig = rigRef.current;
    if (!rig) return;
    const c = rig.controls;

    // Geomagic Design X's navigation, because that is what the operator's
    // hands already know: the middle button turns the model in every mode,
    // Ctrl with it pans, and the wheel zooms. The left button is never
    // navigation there; it belongs to whatever tool is active.
    //
    // OrbitControls does the Ctrl part itself: a button mapped to ROTATE
    // switches to PAN while Ctrl, Meta or Shift is held, so mapping the
    // middle button to ROTATE gives both gestures from one line.
    c.mouseButtons = {
      // The exception, and a deliberate one: with no tool running there is
      // nothing for the left button to do, and a trackpad has no middle
      // button at all. So Orbit lends it out.
      LEFT: props.tool === "orbit" ? THREE.MOUSE.ROTATE : null,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };

    c.touches = {
      // One finger draws the rectangle while Select is up; two fingers always
      // navigate, so there is no mode where a tablet cannot move the view.
      ONE: props.tool === "select" ? null : THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
  }, [props.tool]);

  /* ---------------------------------------------------------------- input */

  const onPointerDown = (e: React.PointerEvent) => {
    const p = propsRef.current;
    const rig = rigRef.current;
    if (!p.cloud) return;
    const host = hostRef.current!;
    const r = host.getBoundingClientRect();

    // Standing in the scan, turning your head is the middle button, the same
    // one that turns the scan from outside. With no tool running the left
    // button lends itself to looking too, for a trackpad with no middle one.
    if (rig?.inside && (e.button === 1 || (e.button === 0 && p.tool === "orbit"))) {
      host.setPointerCapture(e.pointerId);
      lookRef.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;

    if (p.tool === "select") {
      host.setPointerCapture(e.pointerId);
      dragRef.current = {
        x: e.clientX - r.left,
        y: e.clientY - r.top,
        mode: e.shiftKey ? "add" : (e.altKey || e.ctrlKey) ? "subtract" : "replace",
      };
      return;
    }

    if (p.tool === "measure") {
      const hit = pickAt(rigRef.current, p.cloud, e.clientX - r.left,
        e.clientY - r.top, r.width, r.height);
      p.onPickPoint(hit);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const look = lookRef.current;
    const rig = rigRef.current;
    if (look && rig) {
      rig.yaw -= (e.clientX - look.x) * LOOK_RATE;
      // Stopped short of straight up and straight down, where the horizon
      // flips and there is no way to tell which way you are facing.
      rig.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT,
        rig.pitch - (e.clientY - look.y) * LOOK_RATE));
      rig.camera.rotation.set(rig.pitch, rig.yaw, 0);
      look.x = e.clientX;
      look.y = e.clientY;
      rig.needsRender = true;
      return;
    }

    const drag = dragRef.current;
    const el = rectElRef.current;
    if (!drag || !el) return;
    const r = hostRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const left = Math.min(drag.x, x), top = Math.min(drag.y, y);
    el.style.transform = `translate(${left}px, ${top}px)`;
    el.style.width = `${Math.abs(x - drag.x)}px`;
    el.style.height = `${Math.abs(y - drag.y)}px`;
    el.style.display = "block";
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (lookRef.current) {
      lookRef.current = null;
      hostRef.current?.releasePointerCapture?.(e.pointerId);
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    const el = rectElRef.current;
    if (el) el.style.display = "none";
    hostRef.current?.releasePointerCapture?.(e.pointerId);

    const host = hostRef.current!;
    const r = host.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;

    const rig = rigRef.current;
    if (!rig) return;
    const clip = new Float32Array(clipMatrix(rig).elements);

    // A click, not a drag. Clearing the selection is what every other tool
    // does with an empty click, and it beats selecting a one-pixel column.
    if (Math.abs(x - drag.x) < 3 && Math.abs(y - drag.y) < 3) {
      propsRef.current.onRectSelect({ x0: 0, x1: 0, y0: 0, y1: 0 }, "replace", clip);
      return;
    }

    const toNdcX = (v: number) => (v / r.width) * 2 - 1;
    const toNdcY = (v: number) => -((v / r.height) * 2 - 1);
    propsRef.current.onRectSelect(
      {
        x0: Math.min(toNdcX(drag.x), toNdcX(x)),
        x1: Math.max(toNdcX(drag.x), toNdcX(x)),
        y0: Math.min(toNdcY(drag.y), toNdcY(y)),
        y1: Math.max(toNdcY(drag.y), toNdcY(y)),
      },
      drag.mode,
      clip,
    );
  };

  /* ------------------------------------------------------------- thumbnail */
  useEffect(() => {
    if (!props.thumbnailHandle) return;
    props.thumbnailHandle.current = async () => {
      const rig = rigRef.current;
      if (!rig) return null;
      syncOverlay(rig, propsRef.current);
      rig.renderer.render(rig.scene, rig.camera);
      const source = rig.renderer.domElement;
      // Drawn down to a card-sized image rather than stored at window size: a
      // project should not carry a two-megabyte screenshot.
      const w = 480, h = Math.round(w * source.height / Math.max(source.width, 1));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d")?.drawImage(source, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, "image/png"));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    };
    return () => { if (props.thumbnailHandle) props.thumbnailHandle.current = null; };
  }, [props.thumbnailHandle]);

  return (
    <div
      ref={hostRef}
      className={`vpcanvas tool-${props.tool}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div ref={rectElRef} className="marquee" />
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

function disposeCloud(rig: Rig) {
  if (!rig.points) return;
  rig.pivot.remove(rig.points);
  rig.points.geometry.dispose();
  (rig.points.material as THREE.Material).dispose();
  rig.points = null;
  rig.material = null;
  rig.stateAttr = null;
}

/** Object-to-clip for the cloud, which is what both selection and picking
 *  work in. Rebuilt on demand: the camera may have moved since last frame. */
function clipMatrix(rig: Rig): THREE.Matrix4 {
  rig.camera.updateMatrixWorld();
  rig.pivot.updateMatrixWorld();
  return rig.clip
    .copy(rig.camera.projectionMatrix)
    .multiply(rig.camera.matrixWorldInverse)
    .multiply(rig.pivot.matrixWorld);
}

function pickAt(
  rig: Rig | null, cloud: PointCloud,
  px: number, py: number, w: number, h: number,
): number | null {
  if (!rig) return null;
  const m = clipMatrix(rig).elements;
  return cloud.pickNearest(
    m,
    (px / w) * 2 - 1,
    -((py / h) * 2 - 1),
    w / 2, h / 2,
    // Generous, because a point cloud is mostly the gaps between points and a
    // tight radius means clicking three times to catch one.
    14,
  );
}

/**
 * Put the eye in the middle of the scan, standing on its floor.
 *
 * The floor is the bottom of what is left, not of what was opened: after the
 * ground has been cropped away, standing 1.6 m above the original minimum
 * would put you underneath everything.
 */
function standInside(rig: Rig, cloud: PointCloud) {
  const b = cloud.liveBounds() ?? { min: cloud.min, max: cloud.max };

  // The box is measured in the cloud's own frame; the camera lives in the
  // world the pivot rotates that frame into, so the corners are carried over
  // rather than the numbers being used where they do not apply.
  rig.pivot.updateMatrixWorld();
  const v = new THREE.Vector3();
  let minY = Infinity, maxY = -Infinity;
  const worldCentre = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? b.max[0] : b.min[0],
      i & 2 ? b.max[1] : b.min[1],
      i & 4 ? b.max[2] : b.min[2]).applyMatrix4(rig.pivot.matrixWorld);
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
    worldCentre.add(v);
  }
  worldCentre.multiplyScalar(1 / 8);

  // Metres into the scan's own units. Get this wrong and a millimetre scan
  // puts the eye 1.6 mm off the floor and walks at 2.4 mm a second.
  const perMetre = 1 / (cloud.metresPerUnit || 1);
  rig.eyeHeight = EYE_METRES * perMetre;
  rig.speed = SPEED_METRES * perMetre;
  rig.floorY = minY;

  // A scan shorter than a standing person is a desk or an object, not a room.
  // Standing 1.6 m over it would look down on it from outside, so the eye
  // drops to the middle of it instead.
  const height = maxY - minY;
  const eye = height < rig.eyeHeight * 1.2
    ? minY + height / 2
    : minY + rig.eyeHeight;

  rig.camera.position.set(worldCentre.x, eye, worldCentre.z);
  rig.yaw = 0;
  rig.pitch = 0;
  rig.camera.rotation.set(0, 0, 0);

  // Close in, because inside a room everything worth seeing is within a few
  // metres and the default near plane would clip the wall you are facing.
  const span = Math.max(maxY - minY, 1e-6);
  rig.camera.near = Math.max(span / 500, 1e-5);
  rig.camera.far = Math.max(
    Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 4,
    rig.camera.near * 100);
  rig.camera.updateProjectionMatrix();
}

/**
 * One frame of walking. Returns whether anything moved.
 *
 * W and S go where the eye is pointing, flattened onto the floor, so looking
 * up does not lift you off it. A and D strafe. Q and E are the one departure
 * from Design X: a solved room has a floor to stand on, and a raw scan may
 * not, so the eye can be raised and lowered to get over what is in the way.
 */
function walk(rig: Rig, dt: number): boolean {
  if (!dt || !rig.keys.size) return false;

  let fwd = 0, side = 0, lift = 0;
  if (rig.keys.has("w")) fwd += 1;
  if (rig.keys.has("s")) fwd -= 1;
  if (rig.keys.has("d")) side += 1;
  if (rig.keys.has("a")) side -= 1;
  if (rig.keys.has("e")) lift += 1;
  if (rig.keys.has("q")) lift -= 1;
  if (!fwd && !side && !lift) return false;

  const sin = Math.sin(rig.yaw), cos = Math.cos(rig.yaw);
  // Forward at yaw 0 is -Z, which is where a three.js camera looks.
  const dx = -sin * fwd + cos * side;
  const dz = -cos * fwd - sin * side;
  const len = Math.hypot(dx, dz) || 1;
  const step = rig.speed * dt;

  rig.camera.position.x += (dx / len) * step * (fwd || side ? 1 : 0);
  rig.camera.position.z += (dz / len) * step * (fwd || side ? 1 : 0);
  rig.camera.position.y += lift * step;
  return true;
}

function frameCloud(rig: Rig, cloud: PointCloud, animate: boolean) {
  // What is left, not what was opened. Framing on the original box after a
  // crop pulls the camera back to include the wall that was just cut away.
  const b = cloud.liveBounds()
    ?? { min: cloud.min, max: cloud.max };

  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const radius = Math.max(
    Math.hypot(b.max[0] - cx, b.max[1] - cy, b.max[2] - cz), 1e-6);

  rig.pivot.updateMatrixWorld();
  const centre = new THREE.Vector3(cx, cy, cz).applyMatrix4(rig.pivot.matrixWorld);
  const fov = (rig.camera.fov * Math.PI) / 180;
  const distance = (radius / Math.sin(fov / 2)) * 1.15;

  const dir = new THREE.Vector3(0.62, 0.45, 0.65).normalize();
  const target = centre.clone();
  const eye = centre.clone().add(dir.multiplyScalar(distance));

  // Clip planes sized to the thing being looked at. A fixed 0.01 near plane on
  // a scan measured in millimetres wastes the whole depth buffer and the far
  // wall z-fights with the near one.
  rig.camera.near = Math.max(radius / 1000, 1e-4);
  rig.camera.far = distance + radius * 6;
  rig.camera.updateProjectionMatrix();

  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduce) {
    rig.camera.position.copy(eye);
    rig.controls.target.copy(target);
    rig.controls.update();
    rig.needsRender = true;
    return;
  }

  // Fit is a rare, deliberate action, and it is the one place where moving the
  // camera instantly costs the operator their bearings. 260ms of it is enough
  // to carry where the view went without being something you wait through.
  const fromEye = rig.camera.position.clone();
  const fromTarget = rig.controls.target.clone();
  const t0 = performance.now();
  const DURATION = 260;
  const step = () => {
    const t = Math.min((performance.now() - t0) / DURATION, 1);
    const e = 1 - (1 - t) ** 3;   // the same ease-out the interface uses
    rig.camera.position.lerpVectors(fromEye, eye, e);
    rig.controls.target.lerpVectors(fromTarget, target, e);
    rig.controls.update();
    rig.needsRender = true;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ------------------------------------------------------------ measurements */

function rebuildMeasurements(rig: Rig, props: ViewportProps) {
  const cloud = props.cloud;
  rig.lines.traverse((o) => {
    const l = o as Line2;
    l.geometry?.dispose?.();
    (l.material as LineMaterial)?.dispose?.();
  });
  rig.lines.clear();
  rig.labels.replaceChildren();
  if (!cloud) return;

  const size = new THREE.Vector2();
  rig.renderer.getSize(size);

  for (const m of props.measurements) {
    const on = m.id === props.selectedMeasurement;
    const a = cloud.pointAt(m.a);
    const b = cloud.pointAt(m.b);

    const geometry = new LineGeometry();
    geometry.setPositions([...a, ...b]);
    const material = new LineMaterial({
      color: new THREE.Color(on ? GOLD_BRIGHT : GOLD).getHex(),
      linewidth: on ? 3.4 : 2.2,
      // The measurement has to be readable through the surface it was taken
      // across, or half of every interior dimension is invisible.
      depthTest: false,
      transparent: true,
      opacity: on ? 1 : 0.9,
    });
    material.resolution.set(size.x || 1, size.y || 1);
    const line = new Line2(geometry, material);
    line.renderOrder = 10;
    line.userData.measurementId = m.id;
    rig.lines.add(line);

    rig.lines.add(endMarker(a, on));
    rig.lines.add(endMarker(b, on));

    const label = document.createElement("button");
    label.className = `mlabel${on ? " on" : ""}`;
    label.type = "button";
    label.textContent = m.name
      ? `${m.name}  ${formatWithUnit(m.metres, props.displayUnit)}`
      : formatWithUnit(m.metres, props.displayUnit);
    label.dataset.mid = m.id;
    label.onclick = (e) => {
      e.stopPropagation();
      props.onPickMeasurement(m.id);
    };
    rig.labels.appendChild(label);
  }

  // The first end of a measurement in progress, so it is obvious that the app
  // is waiting for a second click rather than having ignored the first.
  if (props.pendingPoint != null && props.pendingPoint < cloud.count) {
    rig.lines.add(endMarker(cloud.pointAt(props.pendingPoint), true));
  }
}

function endMarker(p: [number, number, number], bright: boolean): THREE.Object3D {
  const geometry = new THREE.SphereGeometry(1, 10, 8);
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(bright ? GOLD_BRIGHT : GOLD),
    depthTest: false,
    transparent: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(p[0], p[1], p[2]);
  mesh.renderOrder = 11;
  // Scaled per frame from the camera distance, so an end marker is the same
  // handful of pixels whether the view is across a room or inside a socket.
  mesh.userData.screenScale = true;
  return mesh;
}

/**
 * Put the overlay where the scene is about to be.
 *
 * Two jobs that have to happen in the same pass and before the draw: the end
 * markers are unit spheres whose scale comes from how far away the camera is,
 * and the labels are real DOM sitting on top of the canvas, so both are stale
 * the moment the camera moves.
 */
function syncOverlay(rig: Rig, props: ViewportProps) {
  const cloud = props.cloud;
  if (!cloud) return;

  const size = new THREE.Vector2();
  rig.renderer.getSize(size);
  const v = new THREE.Vector3();

  // End markers first: they share the traversal.
  const eye = rig.camera.position;
  const fov = (rig.camera.fov * Math.PI) / 180;
  const perPixel = (2 * Math.tan(fov / 2)) / Math.max(size.y, 1);
  rig.lines.children.forEach((o) => {
    if (!o.userData.screenScale) return;
    o.getWorldPosition(v);
    // World units per screen pixel at this point's depth, times the radius
    // the marker should have in pixels. Four is small enough not to hide the
    // point it marks and large enough to find.
    o.scale.setScalar(v.distanceTo(eye) * perPixel * 4);
  });

  const labels = rig.labels.children;
  for (let i = 0; i < labels.length; i++) {
    const el = labels[i] as HTMLElement;
    const m = props.measurements.find((x) => x.id === el.dataset.mid);
    if (!m) { el.style.display = "none"; continue; }
    const a = cloud.pointAt(m.a), b = cloud.pointAt(m.b);
    v.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    rig.pivot.localToWorld(v);
    v.project(rig.camera);
    if (v.z > 1) { el.style.display = "none"; continue; }
    el.style.display = "block";
    el.style.transform =
      `translate(${(v.x * 0.5 + 0.5) * size.x}px, ${(-v.y * 0.5 + 0.5) * size.y}px)`
      + ` translate(-50%, -50%)`;
  }
}
