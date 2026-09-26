# Fulcra identity — Keystone

Chosen on 2026-09-23 from six directions. A Roman arch in which every stone is held in place
by one coral wedge at the crown: **one accountable point holding the whole structure up.**

- `icon.png` — opaque square app icon, 1254×1254, subject inside the centre ~70%.
- `mark.png` — transparent silhouette, 1254×1254. Its alpha is also the Android notification shape.
- `adaptive-foreground.png` — the mark at **62%** scale for Android's adaptive icon. Android masks the
  foreground to a circle covering the centre 66/108 of the canvas; the mark as drawn loses **29.8%** of
  its ink to that mask (the arch's square base falls outside the circle), and still clips at 70%.
  Measured, not estimated: at 62% nothing is clipped. Do not reuse `mark.png` as the foreground.
- `icon.svg`, `mark.svg` — hand-written SVG sources.

