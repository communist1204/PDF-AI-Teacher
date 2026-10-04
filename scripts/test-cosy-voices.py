"""Offline regression tests: reject damaged/missing references and escaping paths."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('voice_worker', ROOT / 'cosy-tts-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ReferenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.runtime = Path(self.directory.name)
        self.folder = self.runtime / 'voices'
        self.folder.mkdir()
        self.recording = self.folder / 'local_longanyang.wav'
        self.recording.write_bytes(b'fixed-reference')
        self.item = {'id': 'local_longanyang', 'file': self.recording.name,
                     'sha256': hashlib.sha256(self.recording.read_bytes()).hexdigest(), 'mode': 'cross_lingual'}
        self.write_manifest([self.item])

    def write_manifest(self, items):
        (self.folder / 'manifest.json').write_text(json.dumps({'voices': items}), encoding='utf-8')

    def test_matching_reference_needs_no_guessed_transcript(self):
        path = worker.load_voice_reference(self.runtime, 'local_longanyang')
        self.assertEqual(path, self.recording)

    def test_missing_voice_does_not_fall_back(self):
        with self.assertRaises(worker.VoiceReferenceError):
            worker.load_voice_reference(self.runtime, 'local_longfei_v3')

    def test_corruption_is_rejected(self):
        self.recording.write_bytes(b'changed')
        with self.assertRaises(worker.VoiceReferenceError):
            worker.load_voice_reference(self.runtime, 'local_longanyang')

    def test_unknown_voice_is_rejected(self):
        with self.assertRaises(worker.VoiceReferenceError):
            worker.load_voice_reference(self.runtime, '../outside')

    def test_path_escape_is_rejected(self):
        self.item['file'] = '../local_longanyang.wav'
        (self.runtime / 'local_longanyang.wav').write_bytes(b'fixed-reference')
        self.write_manifest([self.item])
        with self.assertRaises(worker.VoiceReferenceError):
            worker.load_voice_reference(self.runtime, 'local_longanyang')

    def test_duplicate_reference_is_rejected(self):
        self.write_manifest([self.item, self.item])
        with self.assertRaises(worker.VoiceReferenceError):
            worker.load_voice_reference(self.runtime, 'local_longanyang')

    def test_broken_manifest_is_recoverable(self):
        (self.folder / 'manifest.json').write_text('{', encoding='utf-8')
        with self.assertRaises(worker.VoiceReferenceError):
            worker.load_voice_reference(self.runtime, 'local_longanyang')
        self.write_manifest([self.item])
        self.assertEqual(worker.load_voice_reference(self.runtime, 'local_longanyang'), self.recording)

    def test_retired_voice_is_not_a_silent_fallback(self):
        with self.assertRaises(worker.VoiceReferenceError):
            worker.load_voice_reference(self.runtime, 'cosy_default')


if __name__ == '__main__':
    unittest.main()
