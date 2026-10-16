---
name: verify-bgjob-restart
description: Check detached background jobs across an isolated daemon restart on macOS or Linux.
---

Run from the repository root. Install dependencies and build the server package first.
The host must provide `bgjob`, Bash, Git, and `ps`.

```sh
slot-run --pool fulcra --slots 1 --timeout 5 -- node --import tsx .agents/skills/verify-bgjob-restart/verify.mts /tmp/bgjob-restart-proof.json
```

The check creates a scratch home and requests a free loopback port.
It launches the native supervisor and starts detached bgjob runners through a daemon terminal.
Their parent stays alive, so the process tree still contains each job.
One job runs for 60 seconds. The other ends with exit code 7 during downtime.
The check pauses the scratch worker and stops its supervisor.
This forces the supervisor to use its process tree cleanup path.
The check starts the same scratch home again.
It reads their output files and exit codes through a new daemon terminal.
It also starts the public bgjob command. That job ends with exit code 9 during downtime.
The check disables completion messages for this synthetic session. It does not test message delivery.

Pass requires complete output, exit codes 0, 7, and 9, and the forced cleanup log entry.
The JSON proof contains times, process IDs, and the terminal capture.
The scratch directory contains daemon logs and the original process table.
The check keeps these files for review.
It uses only retained scratch process handles. It does not contact the live daemon.
