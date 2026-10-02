# Presentation assets

`fulcra-mark.svg` is copied unchanged from the published Fulcra Keystone mark. `social-preview.png` is the 1280×640 GitHub social preview (under 1 MB): the mark, tagline and a real app screenshot. Root uploads it in GitHub Settings → Social preview.

The README art lives in [`docs/assets/`](../assets/), in light and dark variants that the README switches with `prefers-color-scheme`:

- `hero-*`, `features/`, `screens/`, `phone-*` and the two GIFs contain only real UI: the installed v0.2.0 desktop app and its web build, run against a throwaway demo host (“Demo Mac”) and demo project (“Acme Web”) with short real turns. Phone-width images are the web build's compact layout, not the iOS app.
- `how-it-works-*`, `team-*` and `accounts-*` are designed illustrations. Names and usage bars in `accounts-*` are illustrative and labelled as such.

Everything was rendered from HTML/CSS with Playwright at 2× in the Keystone palette (`#5E1623`, `#FF8A5B`, `#F2E7D5`). Never capture a live host, real account, pairing QR or private session for these images, and strip PNG text metadata before committing.
