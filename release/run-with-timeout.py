#!/usr/bin/env python3
"""run-with-timeout.py <seconds> <cmd...>: run cmd in its own process group; on timeout kill the whole group, exit 124."""
import os, signal, subprocess, sys
t = int(sys.argv[1]); p = subprocess.Popen(sys.argv[2:], start_new_session=True)
try: sys.exit(p.wait(timeout=t))
except subprocess.TimeoutExpired:
    print(f'TIMEOUT after {t}s: process group killed', flush=True)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try: os.killpg(p.pid, sig)
        except ProcessLookupError: break
        try: p.wait(timeout=10); break
        except subprocess.TimeoutExpired: pass
    sys.exit(124)
