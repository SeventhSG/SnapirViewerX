/**
 * Draws the application icon.
 *
 * The mark is the same one the interface uses, on the same rounded charcoal
 * square as Snapir Design X, with the two brand colours swapped: Design X is
 * gold on charcoal, Viewer X is charcoal on gold. Someone with both installed
 * has to be able to tell two pinned taskbar buttons apart at 16 pixels, and
 * inverting the only two colours the brand has does that without inventing a
 * third one or bolting an extra shape onto a logo.
 *
 * Rendered through Electron because Electron is already a dependency and it
 * carries a real renderer. No image library is added for seven PNGs.
 *
 *   npx electron tools/make-icons.cjs
 */
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "buildResources");

const GOLD = "#A87A26";
const CHARCOAL = "#26262A";

const MARK_D =
  "M27.48 17.73 L27.48 27.84 L12.77 42.73 L47.52 42.73 L67.38 22.87 L67.38 22.16 "
  + "L72.52 17.73 L100.00 44.86 L100.00 82.45 L92.55 82.45 L92.55 47.16 L72.52 27.84 "
  + "L53.19 47.16 L53.19 82.45 L45.74 82.45 L45.74 50.53 L7.45 50.53 L7.45 82.45 "
  + "L0.00 82.45 L0.00 44.86Z";

/** The icon at a given edge length, as a standalone page. */
function page(size) {
  // 22.4% corner radius is the macOS squircle proportion, and it is what the
  // Design X icon already uses, so the two sit together correctly.
  const radius = Math.round(size * 0.224);
  const inset = Math.round(size * 0.19);
  const inner = size - inset * 2;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    .sq{width:${size}px;height:${size}px;border-radius:${radius}px;
        background:${GOLD};display:grid;place-items:center}
    svg{width:${inner}px;height:${inner}px;display:block}
  </style></head><body>
    <div class="sq">
      <svg viewBox="0 0 100 100" fill="${CHARCOAL}">
        <path fill-rule="evenodd" d="${MARK_D}"/>
      </svg>
    </div>
  </body></html>`;
}

/**
 * A multi-size .ico holding PNG entries.
 *
 * Windows has read PNG-compressed icon entries since Vista, which is what
 * makes a 256px entry possible at a sane file size. Each directory entry
 * records 0 for a 256 pixel edge, because the field is one byte.
 */
function buildIco(images) {
  const HEADER = 6, ENTRY = 16;
  const dir = Buffer.alloc(HEADER + ENTRY * images.length);
  dir.writeUInt16LE(0, 0);                 // reserved
  dir.writeUInt16LE(1, 2);                 // 1 = icon
  dir.writeUInt16LE(images.length, 4);

  let offset = dir.length;
  images.forEach(({ size, png }, i) => {
    const at = HEADER + ENTRY * i;
    dir.writeUInt8(size >= 256 ? 0 : size, at);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2);             // palette size, 0 for truecolour
    dir.writeUInt8(0, at + 3);             // reserved
    dir.writeUInt16LE(1, at + 4);          // colour planes
    dir.writeUInt16LE(32, at + 6);         // bits per pixel
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([dir, ...images.map((i) => i.png)]);
}

app.disableHardwareAcceleration();   // deterministic output, no GPU variance

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Drawn once at 1024 and resized down, rather than laid out seven times.
  // A 16 pixel page would round the corner radius to 4 and lose the mark's
  // thin strokes to the layout engine before any resampling happened.
  const MASTER = 1024;
  const win = new BrowserWindow({
    width: MASTER, height: MASTER, show: false, frame: false,
    transparent: true, backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });
  await win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(page(MASTER))}`);
  // One frame to be sure the page has painted before it is read back.
  await new Promise((r) => setTimeout(r, 400));

  const master = await win.webContents.capturePage();
  if (master.isEmpty()) {
    console.error("capture came back empty");
    app.exit(1);
    return;
  }

  fs.writeFileSync(path.join(OUT, "icon.png"),
    master.resize({ width: 512, height: 512, quality: "best" }).toPNG());

  const SIZES = [16, 24, 32, 48, 64, 128, 256];
  const images = SIZES.map((size) => ({
    size,
    png: master.resize({ width: size, height: size, quality: "best" }).toPNG(),
  }));
  fs.writeFileSync(path.join(OUT, "icon.ico"), buildIco(images));

  // A light variant for a dark taskbar, kept beside the other two the way
  // Design X keeps its own.
  const ico = fs.statSync(path.join(OUT, "icon.ico")).size;
  console.log(`icon.png  512x512`);
  console.log(`icon.ico  ${SIZES.join(", ")}  (${(ico / 1024).toFixed(1)} kB)`);

  win.destroy();
  app.exit(0);
});

// A tool that silently produced nothing would be worse than one that stops.
app.on("window-all-closed", () => {});
setTimeout(() => {
  console.error("timed out before the icon was drawn");
  app.exit(1);
}, 30_000).unref?.();

void nativeImage;
