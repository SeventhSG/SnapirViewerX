# The `.svxp` project format

Version 1.

A Snapir Viewer X project is a ZIP archive. Not a clever container: a ZIP means
that in ten years, with or without this program, anyone can open one with the
tools already on their machine and see exactly what their data is.

```
project.svxp
├── manifest.json        what this is, and what the scan is
├── points.bin           float32 x y z, interleaved, little endian
├── colors.bin           uint8 r g b, interleaved
├── deleted.bin          uint32 indices of removed points   (optional)
├── measurements.json    the measurements                    (optional)
├── view.json            display preferences                 (optional)
└── thumbnail.png        a small picture of the last view    (optional)
```

---

## The decision worth knowing about

**A project holds the whole scan plus a list of which points are deleted, not
the surviving points.**

Cutting in this application is non-destructive on purpose. Reopening a job a
year later and putting a wall back has to be possible, and that is only true
if the wall is still in the file.

The consequence is that a project does not shrink as you clean it. A scan of
20 million points is about 300 MB as a `.svxp` whether you have deleted none
of it or nine tenths. Exporting `.ply` is what produces a file with the
deleted points actually gone.

---

## `manifest.json`

The only required entry besides the two `.bin` files. A reader should check
`format` and `formatVersion` before anything else.

```json
{
  "format": "svxp",
  "formatVersion": 1,
  "writer": { "name": "Snapir Viewer X", "version": "0.1.0" },
  "created": "2026-09-21T18:22:05.114Z",
  "modified": "2026-09-21T19:40:51.802Z",
  "scan": {
    "name": "kitchen",
    "sourceFile": "C:\\scans\\kitchen.ply",
    "sourceEncoding": "binary_little_endian",
    "sourceUnit": "m",
    "pointCount": 1803990,
    "deletedCount": 470988,
    "hasColor": true,
    "offset": [1.4032, -0.2201, 3.8874],
    "min": [0, 0, 0],
    "max": [4.004, 2.504, 3.204],
    "comments": ["exported by Scaniverse"]
  }
}
```

| Field | Meaning |
|---|---|
| `formatVersion` | A reader that finds a number higher than it knows must refuse rather than guess |
| `scan.sourceUnit` | What one stored unit means: `mm`, `cm`, `m`, `in` or `ft`. A PLY cannot carry this, so the project does |
| `scan.pointCount` | Points in `points.bin`, **including deleted ones** |
| `scan.offset` | Add this to a stored coordinate to recover the original file coordinate |
| `scan.min` / `max` | The bounding box in stored space, so already relative to `offset` |

### Why `offset` exists

A float32 holds about seven significant digits. A scan sitting at a survey
coordinate of 4,500,000 would quantise to roughly 30 cm, and every measurement
taken off it would be noise.

So coordinates are stored relative to a local origin near the scan, and
`offset` carries the part that was taken out. To recover the coordinate the
original file had:

```
file_coordinate = stored_coordinate + offset
```

The reader picks the first vertex of the source as that origin, which is why
the first point of a freshly imported scan is exactly `[0, 0, 0]`.

---

## `points.bin` and `colors.bin`

Both are raw interleaved arrays with no header, stored **uncompressed** inside
the ZIP. Float32 coordinates are close to incompressible, and deflating a
quarter of a gigabyte to save two percent would add a minute to every save.

```
points.bin   float32 little endian, 3 per point:   x0 y0 z0 x1 y1 z1 ...
colors.bin   uint8, 3 per point:                   r0 g0 b0 r1 g1 b1 ...
```

Both have exactly `scan.pointCount * 3` elements. A reader must treat a
mismatch as a corrupt project rather than reading what it can: a colour array
one point short silently shifts the colour of every point after it.

When the source had no colour, `hasColor` is `false` and `colors.bin` is
filled with a neutral grey so that the array length still matches.

---

## `deleted.bin`

Absent when nothing has been deleted.

`uint32` little endian, ascending, one index per removed point, indexing into
`points.bin`. Deflated normally: a sorted index list compresses very well.

An index at or beyond `pointCount` is corrupt. A reader should drop it rather
than fail, because the rest of the project is still usable.

---

## `measurements.json`

An array. Absent or empty when nothing has been measured.

```json
[
  {
    "id": "mkx91v2a3f",
    "a": 118204,
    "b": 902551,
    "metres": 2.5072,
    "name": "Floor to ceiling"
  }
]
```

| Field | Meaning |
|---|---|
| `a`, `b` | Indices into `points.bin`. Kept as indices rather than coordinates so a measurement always lands exactly on the points it was taken between |
| `metres` | The length, **always in metres** whatever the display unit. Stored rather than recomputed, so a reopened project reads the same number even if the source unit is later corrected by hand |
| `name` | Free text. May be empty |

A measurement whose `a` or `b` falls outside the cloud is dropped on load: a
line drawn to nowhere is worse than a missing line.

Note that a measurement can refer to a deleted point. That is deliberate and
not corruption. The measurement was taken before the cut, the point is still
in the file, and undoing the cut brings both back.

---

## `view.json`

Display preferences. Every field is optional and a reader should fall back to
its own defaults.

```json
{ "displayUnit": "m", "pointSize": 2, "background": "light" }
```

None of this is geometry. A project opened with a different `displayUnit`
shows different numbers for the same distances and is not a different project.

---

## `thumbnail.png`

A small PNG of the view as it was last saved, used on the recent-scans list.
Stored uncompressed inside the ZIP, because a PNG is already deflated.

Absent when the project was written without a view to capture.

---

## Reading one without this application

The point of the container. In Python, with nothing but the standard library
and NumPy:

```python
import json, zipfile
import numpy as np

with zipfile.ZipFile("project.svxp") as z:
    manifest = json.loads(z.read("manifest.json"))
    n = manifest["scan"]["pointCount"]

    xyz = np.frombuffer(z.read("points.bin"), dtype="<f4").reshape(n, 3)
    rgb = np.frombuffer(z.read("colors.bin"), dtype=np.uint8).reshape(n, 3)

    keep = np.ones(n, dtype=bool)
    if "deleted.bin" in z.namelist():
        keep[np.frombuffer(z.read("deleted.bin"), dtype="<u4")] = False

# The points that survived the clean, in the file's original coordinates.
points = xyz[keep] + np.array(manifest["scan"]["offset"], dtype=np.float64)
colors = rgb[keep]

# Metres, whatever the file was measured in.
scale = {"mm": 1e-3, "cm": 1e-2, "m": 1.0, "in": 0.0254, "ft": 0.3048}
metres = points * scale[manifest["scan"]["sourceUnit"]]
```

---

## Compatibility

`formatVersion` is incremented when an existing field changes meaning or a
required entry is added. Adding an optional entry does not increment it, so a
reader must ignore entries it does not recognise rather than refuse the file.

Snapir Viewer X refuses a project whose `formatVersion` is higher than it
knows, and says which version it can read.
