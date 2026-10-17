# Local instruction files

Fulcra reads user instruction files. It does not install global `CLAUDE.md` or `AGENTS.md` files.
Bundled skills describe Fulcra tools and point to user instructions.
Keep personal rules in user files and personal skills.

Skill maintenance runs at daemon startup and through the app's skill controls.
It installs missing files. It updates files that still match their last installed hash.
Without an ownership record, it can also update bytes from a known shipped version.
A local change to another shipped version remains a local change when an ownership record exists.
Unknown or edited files remain unchanged. A new bundled version goes beside the file as `<name>.new`.
If that path already has other bytes, maintenance uses a dated copy.
It keeps edited update copies too. Each saved version produces one notice.
An append-only receipt prevents repeat notices across daemon restarts, including after an owner removes an offer.
A read-only status request does not write copies or log notices.

The application includes `skills/.bundled-skill-hashes.json` as trusted history.
The initial record contains hashes from release tags and the change's base revision.
Before a skill release, run `node scripts/record-bundled-skill-hashes.mjs`.
Keep old entries. The server build checks that current bundle hashes are recorded.
Without an ownership record, current source bytes also identify an unchanged bundle.
A known local edit stays local when a later bundle has the same bytes.

Settings maintenance uses the last installed whole-file hash.
It also recognizes shipped hook-only files from before ownership records existed.
An unknown existing settings file remains unchanged, even when its parsed hooks already match.
Adding a setting does not transfer ownership of the file to Fulcra.
An existing setting can therefore prevent automatic hook installation. The notice identifies the file.
Settings offers contain bundled settings only. The notice says to merge them and keep the user's file.
Changes to user settings do not create new offers when the bundled settings stay the same.

Checked writes reject symbolic links and linked parent directories.
They check destination bytes before replacement and keep displaced originals as recovery files.
Recovery files end in `.backup`. They do not load as plugin code.

Automatic maintenance does not remove deselected skills.
Explicit skill removal remains a user operation.
