# 0.2.0

Scale, mostly. 0.1.0 held about five million points comfortably; this one has
been measured at fifty million on a mid-range card.

## Fifty million points

| Scan | Points | Read | Turning | At rest |
|---|---|---|---|---|
| Room, synthetic | 1,803,990 | 0.2 s | 75 fps | 0 fps |
| Building, SiteScape | 4,879,915 | 1.4 s | 75 fps | 0 fps |
| Building, synthetic | 50,000,000 | 10.2 s | 75 fps | 0 fps |

Measured on a GTX 1660 Super with 16 GB of memory. 75 fps is that monitor's
refresh rate, so it is the ceiling of the test rather than the limit of the
application.

Three changes got it there.

- **The whole cloud is drawn only when the camera is still.** While you turn
  or walk, a four million point sample is drawn instead, enlarged slightly so
  the scan keeps its coverage; the moment you stop, the full cloud is drawn
  once. You always end up reading a complete picture, and never wait for one.
- **Point order is shuffled on import**, which is what makes that sample fair.
  Without it the first four million points are one corner of the building and
  the rest of it vanishes every time you move.
- **The bounding box is cached against the geometry rather than the
  selection.** A marquee drag changes the selection hundreds of times and can
  never move a point, so re-measuring the scan on each of those was walking
  fifty million points for an answer that had not changed.

Selection is untouched by any of this: a rectangle always tests every point in
the scan, drawn or not, so what you cut is never limited to what was on screen.

Colour is now passed straight from the file to the framebuffer instead of
being converted to linear and back, which removes a `pow` per point per frame
and, incidentally, makes what is on screen exactly what is in the scan.

## Walking is slower

1.2 m/s rather than 2.4. Design X's speed is right for inspecting a solved
room; in a raw scan the point of being in there is to look closely at a
surface a metre away, and at 2.4 a single tap of the key crossed it. **Shift**
gives the old speed back for crossing a large building.

## Units in one place

The display unit now sits in the inspector directly above the measurements it
governs, as well as in **Settings, Units**. Changing it changes every length
at once: the labels on the measurement lines in the viewport, the measurement
list, and the scan's size and diagonal. It remains entirely separate from the
scan's own source unit, which is a property of the file and not a preference.

## Frame rate readout

**Settings, Appearance, Show frame rate** puts the rate and the number of
points being drawn in the corner of the viewport. Off by default. It is the
quickest way to find the point size a given scan can afford, and it also
writes the same line to the log so a slow machine can be diagnosed from a
file.

## Limits

Unchanged from 0.1.0, except that the size ceiling is now memory rather than
frame rate: a 50 million point scan occupies about 2.3 GB across the
application's processes, so 16 GB of system memory is a sensible floor for
scans that large.

Point order is no longer preserved from the source file, as a consequence of
the shuffle. An exported `.ply` holds the same points in a different order.

64 self-test checks, up from 56. The new ones cover the shuffle keeping every
point and its colour together, its determinism, and the bounds cache
invalidating on an edit but not on a selection.
