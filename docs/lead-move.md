# Moving a lead to another chat or computer (FU-444)

Use `scripts/lead-move.mjs` for each step. The script is one file with no repo imports. You can copy it to a computer
that has no checkout. Each step that changes a file keeps a dated backup (`<file>.bak-fu444-<time>`), writes the new
file, and then renames it. No step archives a chat.

## Before you start

1. Move the transcript and import the new chat as the fulcra-team skill tells you ("Moving a lead to another host").
2. Write down the full ids (36 characters) of the old lead and the new lead.
3. Write down the new lead's server id: `node scripts/lead-move.mjs status` on its computer.

## Steps

1. **Notices follow the lead.** Do this on each computer that has workers of the old lead:

   ```sh
   # New lead on this computer:
   node scripts/lead-move.mjs forward --old <old id> --new <new id>
   # New lead on the PC, workers on a Mac:
   node scripts/lead-move.mjs forward --old <old id> --new <new id> \
     --server <PC server id> --relay ~/.local/bin/pcsend {id} {file}
   ```

   The daemon reads `<daemon home>/lead-moves.json` at each notice. You do not have to restart it. A finish, permission,
   limit or nudge notice for the old lead then goes to the new lead. If the new lead is on another computer, the daemon
   runs the relay command with no shell. The notice text goes in a private temporary file, so quoting cannot cut it.
   Keep the old lead chat (do not archive it) while its workers run. A notice for an archived lead is not sent.

2. **Local reporting lines.** On the new lead's computer, point its own chats from the old lead to the new one:

   ```sh
   node scripts/lead-move.mjs relabel --old <old id> --new <new id>
   ```

   Do not use `relabel` on other computers. A worker there must keep the old id, so that step 1 forwards its notices.

3. **Gate lists (Mac mini).** Allow the new lead and route its Mac workers. Remove the old ids:

   ```sh
   node scripts/lead-move.mjs routes --lead <new id> --drop <old id> --worker <worker id>=mini
   ```

   The step changes `~/.config/fulcra/pc-notify-leads.txt` and `~/.config/fulcra/pc-notify-routes.txt`.

4. **Send to a moved lead with one command.** The full text goes from stdin or a file:

   ```sh
   node scripts/lead-move.mjs send <lead id> <<'EOF'
   The full message, with "quotes", & signs and new lines.
   EOF
   ```

   If the lead is on this computer, the script uses `paseo send --prompt-file`. If not, it uses `pcsend <id> <file>`
   (change it with `--relay <argv ...>`).

## Not in this step: the Leads sidebar seat

The Leads sidebar lists a lead only when the controller on the lead's own computer has a project seat for it.
On Windows, seat writes failed until PR #126 (FU-444b): the catalog temp file was opened read-only before fsync, and
Windows refuses fsync on a read-only handle (EPERM). With #126 a PC lead can be seated; no password change is needed.
