"""Keep close times with their evidence. Preserve private tool settings."""
import re
import time

VERSION = "2026-10-16-close-time"
RECORD = re.compile(r"Closed at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")


def close_evidence(evidence, previous):
    closed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    earlier = re.sub(RECORD.pattern + r";?\s*", "", previous)
    proof = evidence if earlier in ("—", "") else f"{evidence}; earlier: {earlier}"
    return f"Closed at {closed_at}; {proof}"


def keep_close_time(status, previous, evidence):
    record = RECORD.search(previous)
    return f"{record.group(0)}; {evidence}" if status == "DONE" and record else evidence


def prepare_ledger(source):
    """Retired: update the command through the ledger source package."""
    raise ValueError("The legacy ledger patch is retired. Use the ledger source package.")
