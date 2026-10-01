# Fulcra identity

Original Fulcra assets generated on 17 September 2026 with the built-in OpenAI image generation tool. The icon uses an intentional seafoam background for contrast against either app theme; the mark has transparency. Keep these sibling assets separate from the upstream Paseo images.

Source masters and generation prompts are retained in the Fulcra foundation project under `brand/orca-v1`, asset commit `2897858`. The desktop package uses the same unmodified icon master. Expo and Electron build tools generate platform icon formats and sizes from these PNGs.

- `icon.png`: opaque square app icon and in-app badge, 1254×1254.
- `mark.png`: transparent symbol, including the alpha silhouette used by Android notification styling, 1254×1254.

The ordinary Android icon comes from the shared Expo icon setting. A separate adaptive foreground should only be added after its padding and masks are verified; do not reuse the upstream Paseo adaptive foreground.
