# Website assets

`fulcra-mark.svg` is byte-for-byte `packages/app/assets/images/fulcra-v1/icon.svg`, the Keystone app icon.

## Product screenshots (`public/fulcra/assets/shots/`)

Real captures of the installed Fulcra 0.2.3 Mac app (development build, renderer v0.10.3), taken on 6 October 2026. Nothing in them is mocked or repainted.

How they were made, so they can be redone after the next build:

1. Start a separate daemon from the installed app with its own home and port (for example `~/fulcra-site-demo/home`, `127.0.0.1:6899`), a clean environment and `FULCRA_COMMAND_CENTRE=1`. Its Command Centre state lives under that home, so it never touches the live control plane.
2. Register two small demo repositories (`habit-tracker`, `weather-cli`) and run real Claude sessions on them (`paseo run --new-workspace worktree ...`). Rename the host to "Studio Mac" so no machine name appears.
3. Launch a second copy of the installed app with `PASEO_ELECTRON_USER_DATA_DIR` pointing at a scratch folder and `--remote-debugging-port`, connect it to the demo daemon, and capture at 1440×900 @2x through CDP.
4. Crop only to remove the repeated sidebar in the step images. Check every frame at full size for names, paths, account details and credits before committing.

The usage panel is not shown: in the demo it reported an error for Claude and a real account's credit balance for Codex.

## Other files

`social-preview.png` is rendered from `social-preview.html` (brand, headline and the real diff capture). The team hierarchy on the page is HTML and labelled as an illustration. The README team art is its visual reference.
