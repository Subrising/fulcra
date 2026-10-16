"""Compatibility names. The functions live only in the private ledger command."""
import importlib.util
import os
from pathlib import Path

path = Path(os.environ.get("LEDGER_TEST_MODULE", Path.home() / ".local/share/ledger/ledger.py"))
spec = importlib.util.spec_from_file_location("_ledger_close_source", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
close_evidence = module.close_evidence
keep_close_time = module.keep_close_time
VERSION = module.VERSION
RECORD = module.RECORD


def prepare_ledger(source):
    """Accept the self-contained command. Refuse the old import patch."""
    if ("def close_evidence(" not in source or "def keep_close_time(" not in source
            or "from ledger_close_time import" in source):
        raise ValueError("Install the canonical ledger source; do not patch a runtime helper import.")
    compile(source, "ledger.py", "exec")
    return source
