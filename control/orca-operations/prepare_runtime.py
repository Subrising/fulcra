"""Reproduce the private Node runtime and its pinned npm security maintenance."""
import base64
import hashlib
import json
from pathlib import Path

# Machine-specific legacy deployment inputs live outside the tracked tree.
def local_machine(key):
    config = Path(__file__).resolve().parents[2] / 'local' / 'machine-values.json'
    if not config.is_file():
        raise ValueError('Populate local/machine-values.json before running this legacy deployment tool')
    value = json.loads(config.read_text()).get(key)
    if not isinstance(value, str) or not value.startswith('/'):
        raise ValueError('Missing canonical local machine path: ' + key)
    return value
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


def fetch(url, destination):
    with urllib.request.urlopen(url, timeout=60) as response:
        destination.write_bytes(response.read())


def prepare(pin, base):
    base.mkdir(exist_ok=True, parents=True, mode=0o700)
    target = base / pin['archive'].removesuffix('.tar.gz')
    if target.exists():
        raise RuntimeError('Runtime already exists; preserve it and prepare a fresh target')
    with tempfile.TemporaryDirectory(dir=base) as directory:
        temp = Path(directory)
        archive = temp / 'node.tar.gz'
        fetch(pin['url'], archive)
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == pin['sha256']
        with tarfile.open(archive) as tar:
            tar.extractall(temp, filter='data')
        tree = temp / target.name
        for package in pin['packages']:
            archive = temp / (package['name'] + '.tgz')
            fetch(package['url'], archive)
            algorithm, expected = package['integrity'].split('-', 1)
            assert algorithm == 'sha512'
            assert base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode() == expected
            unpack = temp / ('unpack-' + package['name'])
            unpack.mkdir()
            with tarfile.open(archive) as tar:
                tar.extractall(unpack, filter='data')
            source = unpack / 'package'
            info = json.loads((source / 'package.json').read_text())
            assert info['name'] == package['name'] and info['version'] == package['version']
            dest = tree / package['destination']
            assert dest.resolve().is_relative_to(tree.resolve())
            if dest.exists(): shutil.rmtree(dest)
            shutil.move(source, dest)
        assert subprocess.check_output([tree / 'bin/node', '--version'], text=True).strip() == 'v' + pin['version']
        shutil.move(tree, target)
    return target


if __name__ == '__main__':
    print(prepare(json.loads(Path(__file__).with_name('node-runtime.json').read_text()), Path(local_machine("nodeInstallHome"))))
