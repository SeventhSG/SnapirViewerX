# 0.1.0

The first release. Open a full-colour LiDAR scan from an iPhone or iPad, cut
away what is not the building, measure what is, and hand the result on.

## What it does

- **Reads `.ply`** in all three encodings the format defines, and finds colour
  whether the file spells it `red green blue`, `r g b` or `diffuse_red`.
  A mesh exported as `.ply` opens as the point cloud inside it, and a Gaussian
  splat `.ply` opens in colour rather than grey.
- **Rectangle selection that cuts through the scan**, so removing a person
  standing in a room takes one pass and not one per wall. Shift adds, Alt
  subtracts, Delete removes, and undo is unlimited within a session.
- **Measurement between two points**, named, listed, and shown in mm, cm, m,
  inches or feet. Picking finds the nearest surface and then the point you
  actually pointed at on it, so a measurement neither snaps through a wall nor
  drifts inward from the corner you aimed for.
- **Standing inside the scan** and walking it with `W A S D`, at the same
  speed and with the same keys as walking a solved room in Snapir Design X.
  Selecting and measuring both work from in there.
- **Two ways out.** A `.svxp` project keeping the whole scan and the cut list,
  so the job can be reopened and changed, and a cleaned `.ply` with the
  deleted points actually gone.
- **English and Turkish**, light and dark.

## Things worth knowing

- **Source unit against display unit.** A PLY cannot record what one unit
  means. The scan's own unit is a property of the file and sits in the
  inspector; the unit you read lengths in is a preference and changes no
  geometry. Almost every phone scanner writes metres, which is the default.
- **A project does not shrink as you clean it.** It keeps the points you
  deleted, because that is what makes the cut reversible later. Export `.ply`
  for a file with them gone.
- **Nothing leaves the machine.** No account, no upload, no telemetry, no
  backend. The only network call is the update check against this repository.

## Measured, not asserted

Checked against a synthetic room built to exactly 4.000 by 2.500 by 3.200 m:

```
56 checks passed, 0 failed
binary PLY read at about 17M points/s
measurement across the room: 4.000 m, to within a tenth of a millimetre
```

In the application, on a 1,803,990 point scan of the same room:

| Dimension | True | Measured |
|---|---|---|
| Floor to ceiling | 2.500 m | 2.5072 m |
| Ceiling diagonal | 5.1281 m | 5.1257 m |

Both inside the fixture's own noise, which is 4 mm on every coordinate.

## Limits

- **PLY only.** No LAS, LAZ or E57.
- **The whole cloud is held in memory** and drawn in one call, with no
  streaming and no level of detail. Comfortable to about 20 million points.
- **The installer is not code-signed**, so Windows SmartScreen will warn on
  first run. **More info**, then **Run anyway**.
- **Windows only** is what is built and tested.

## Install

Download `SnapirViewerX-0.1.0-setup.exe` and run it. Windows 10 or 11,
64-bit. After that, `.svxp` and `.ply` open by double-clicking and the app
updates itself from this repository.
