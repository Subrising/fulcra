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
    """Apply only close-time changes to the existing private command."""
    replacements = [
        ('HOME = os.path.expanduser("~")', 'from ledger_close_time import close_evidence, keep_close_time, VERSION\n\nHOME = os.path.expanduser("~")'),
        ('        c[5] = ev if c[5] in ("—", "") else f"{ev}; earlier: {c[5]}"', '        c[5] = close_evidence(ev, c[5])'),
        ('            c[5] = clean(o["evidence"], "--evidence")', '            c[5] = keep_close_time(c[4], c[5], clean(o["evidence"], "--evidence"))'),
        ('    return p, open(p).read().split("\\n")', '    with open(p) as f:\n        return p, f.read().split("\\n")'),
    ]
    for old, new in replacements:
        if source.count(old) != 1:
            raise ValueError("The installed tool changed. Review it before applying the close-time update.")
        source = source.replace(old, new)
    return source
