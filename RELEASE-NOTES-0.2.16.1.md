# Fulcra 0.2.16.1

This release gives the source code only. It does not include an app download. To use Fulcra, build and package your own app. The README section "Build and package your own Fulcra" gives the steps. On Windows, use the Windows guide (docs/windows.md).

Fulcra 0.2.16.1 is based on Paseo v0.11.0-beta.5. It is a small fix release on top of 0.2.16.

## New in 0.2.16.1

### Daemon hangs

- A stop always ends within 30 s, also when the daemon worker's main thread is blocked. A watchdog on its own thread ends the worker at the deadline.
- The supervisor restarts a worker that answers no heartbeat for 3 minutes. Before, a worker with a blocked main thread stayed up and answered nothing until someone restarted it by hand.
- The Command Centre controller restarts by itself after a refused recovery.

### One Fulcra app per computer (macOS)

- Daemon processes no longer show as Dock apps named "exec" or in Force Quit. The service, the command line daemon and the app-managed daemon run as background helpers.
- A second start of the app brings the running window to the front. Only an explicit project path opens a new window.
- A daemon worker exits at once, with the reason in daemon.log, when another live process holds its home lock.
- Test and CI scripts that start an app or a daemon refuse a home folder that is not a test home.
