"""Check close records in a temporary ledger. Live lists stay unchanged."""
import datetime
import importlib.util
import os
import pathlib
import tempfile
import unittest

from ledger_close_time import close_evidence, keep_close_time, prepare_ledger

installed = os.environ.get("LEDGER_TEST_MODULE")
ledger = None
if installed:
    spec = importlib.util.spec_from_file_location("ledger", installed)
    ledger = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ledger)


class EvidenceTests(unittest.TestCase):
    def test_iso_close_record_with_evidence(self):
        record = close_evidence("PR 50", "—")
        print(record)
        at = datetime.datetime.fromisoformat(record.split(";")[0].removeprefix("Closed at ").replace("Z", "+00:00"))
        self.assertLess(abs((datetime.datetime.now(datetime.timezone.utc) - at).total_seconds()), 5)
        self.assertIn("PR 50", record)

    def test_evidence_updates_keep_the_close_time(self):
        old = close_evidence("PR 50", "—")
        self.assertEqual(keep_close_time("DONE", old, "PR 51"), old.split(";")[0] + "; PR 51")
        reopened = close_evidence("PR 51", old)
        self.assertEqual(reopened.count("Closed at "), 1)
        self.assertIn("PR 50", reopened)
        self.assertIn("PR 51", reopened)

    def test_legacy_patch_cannot_restore_the_runtime_import(self):
        source = '\n'.join([
            'HOME = os.path.expanduser("~")',
            '        c[5] = ev if c[5] in ("—", "") else f"{ev}; earlier: {c[5]}"',
            '            c[5] = clean(o["evidence"], "--evidence")',
            '    return p, open(p).read().split("\\n")',
        ])
        with self.assertRaisesRegex(ValueError, "retired"):
            prepare_ledger(source)


@unittest.skipUnless(installed, "Set LEDGER_TEST_MODULE to check the installed private command.")


class CloseTimeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous = os.environ.get("LEDGER_ROOT")
        os.environ["LEDGER_ROOT"] = self.directory.name
        ledger.cmd_init(["fixture"])
        ledger.cmd_add(["fixture", "--id", "TEST-1", "--kind", "FIX", "--owner", "Worker", "--item", "Check dates", "--source", "Test"])

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("LEDGER_ROOT", None)
        else:
            os.environ["LEDGER_ROOT"] = self.previous
        self.directory.cleanup()

    def row(self):
        _, lines = ledger.load("fixture")
        return ledger.parse_row(lines[ledger.find(lines, "TEST-1")])

    def test_close_records_iso_time_and_keeps_it_when_evidence_changes(self):
        before = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        ledger.cmd_close(["fixture", "TEST-1", "--evidence", "PR 50"])
        row = self.row()
        self.assertEqual(row[4], "DONE")
        record = row[5].split(";")[0]
        at = datetime.datetime.fromisoformat(record.removeprefix("Closed at ").replace("Z", "+00:00"))
        self.assertGreaterEqual(at, before)
        self.assertLessEqual(at, datetime.datetime.now(datetime.timezone.utc))
        ledger.cmd_set(["fixture", "TEST-1", "--evidence", "commit abcdef1"])
        self.assertTrue(self.row()[5].startswith(record + ";"))
        self.assertIn("commit abcdef1", self.row()[5])
        with self.assertRaises(ledger.Refused):
            ledger.cmd_close(["fixture", "TEST-1", "--evidence", "PR 50"])

    def test_close_without_evidence_keeps_row_open(self):
        with self.assertRaises(ledger.Refused):
            ledger.cmd_close(["fixture", "TEST-1", "--evidence", "none"])
        self.assertEqual(self.row()[4], "OPEN")

    def test_reopen_discards_the_old_close_record_on_next_close(self):
        ledger.cmd_close(["fixture", "TEST-1", "--evidence", "PR 50"])
        ledger.cmd_set(["fixture", "TEST-1", "--status", "OPEN"])
        ledger.cmd_close(["fixture", "TEST-1", "--evidence", "PR 51"])
        self.assertEqual(self.row()[5].count("Closed at "), 1)
        self.assertIn("PR 51", self.row()[5])


if __name__ == "__main__":
    unittest.main()
