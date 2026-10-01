import hashlib, importlib.util, json, os, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('reader', Path(__file__).with_name('worker-artifacts.py'))
reader = importlib.util.module_from_spec(spec); spec.loader.exec_module(reader)
class Races(unittest.TestCase):
    def test_replaced_directory_cannot_redirect_descriptor_reads(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve() / 'worker'; root.mkdir()
            (root / 'guide.md').write_text('original')
            manifest = json.dumps({'version': 1, 'files': [{'path': 'guide.md', 'sha256': hashlib.sha256(b'original').hexdigest()}]})
            (root / '.orca-artifacts.json').write_text(manifest)
            original_open, seen, replaced = os.open, [], []
            def open_file(name, flags, *args, **kwargs):
                if name == 'guide.md' and not replaced:
                    root.rename(root.with_name('saved')); root.mkdir()
                    (root / 'guide.md').write_text('redirected')
                    (root / '.orca-artifacts.json').write_text(manifest); replaced.append(True)
                fd = original_open(name, flags, *args, **kwargs)
                if name == 'guide.md':
                    seen.append(os.read(fd, 64)); os.lseek(fd, 0, os.SEEK_SET)
                return fd
            with patch.object(os, 'open', open_file): result = reader.inspect(str(root))
            self.assertEqual(seen, [b'original']); self.assertEqual(result['state'], 'unavailable'); self.assertEqual(result['files'], [])
            self.assertIn('directory or declaration changed', result['error'])
    def test_file_changed_during_fd_read_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); (root / 'guide.md').write_text('original')
            (root / '.orca-artifacts.json').write_text(json.dumps({'version': 1, 'files': [{'path': 'guide.md', 'sha256': hashlib.sha256(b'original').hexdigest()}]}))
            original_read = os.read
            def read(fd, n):
                data = original_read(fd, n)
                if data == b'original': (root / 'guide.md').write_text('modified')
                return data
            with patch.object(os, 'read', read): result = reader.inspect(str(root))
            self.assertEqual(result['state'], 'unavailable'); self.assertEqual(result['files'], [])
if __name__ == '__main__': unittest.main()
