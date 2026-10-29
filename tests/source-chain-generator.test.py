import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("source_chain", Path(__file__).resolve().parents[1] / "scripts/build/generate-source-chain.py")
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class SourceChainTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pob-chain-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.repo / "src").mkdir()
        (self.repo / "src/a.lua").write_text("local a = 1\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-qm", "Synthetic generator fixture")
        self.pin = {"revision": self.git("rev-parse", "HEAD").strip(), "compositePatch": {"patchFile": "patches/composite.patch"}, "overlays": [
            {"id": "power-report-relevance-pruning", "applicationStage": "source-composite", "patchFile": "patches/relevance.patch"},
            {"id": "power-report-environment-reuse", "applicationStage": "source-composite", "patchFile": "patches/reuse.patch"},
        ]}
        self.layers = [
            {"src/a.lua": "local a = 2\n", "src/new.lua": None},
            {"src/a.lua": "local a = 2\n", "src/new.lua": "return 'é'"},
            {"src/a.lua": "local a = 3\n", "src/new.lua": "return 'é'"},
        ]

    def git(self, *args):
        return subprocess.check_output(["git", "-c", "core.autocrlf=false", *args], cwd=self.repo, encoding="utf-8")

    def run_generator(self):
        (self.root / "pin.json").write_text(json.dumps(self.pin), encoding="utf-8")
        for index, layer in enumerate(self.layers):
            (self.root / f"{index}.json").write_text(json.dumps(layer), encoding="utf-8")
        generator.generate(SimpleNamespace(pin=self.root / "pin.json", checkout=self.repo, pr_layer=self.root / "0.json", relevance_layer=self.root / "1.json", final_layer=self.root / "2.json", out=self.root / "out"))
        return json.loads((self.root / "out/source-pin.json").read_text(encoding="utf-8"))

    def test_round_trip_tree_new_file_utf8_and_index_isolation(self):
        result = self.run_generator()
        tree = result["compositePatch"]["resultTree"]
        self.assertEqual(self.git("show", f"{tree}:src/new.lua"), "return 'é'")
        self.assertEqual(self.git("show", f"{tree}:src/a.lua"), "local a = 3\n")
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertIn("\\ No newline at end of file", (self.root / "out/patches/composite.patch").read_text())
        with self.assertRaises(AssertionError):
            self.run_generator()

    def test_wrong_base_rejected(self):
        self.pin["revision"] = "0" * 40
        with self.assertRaises(AssertionError):
            self.run_generator()

    def test_missing_new_file_rejected(self):
        del self.layers[-1]["src/new.lua"]
        with self.assertRaises(AssertionError):
            self.run_generator()

    def test_reordered_required_layers_rejected(self):
        self.pin["overlays"].reverse()
        with self.assertRaises(AssertionError):
            self.run_generator()

    def test_empty_required_layer_rejected(self):
        self.layers[-1] = self.layers[-2].copy()
        with self.assertRaises(AssertionError):
            self.run_generator()

    def test_path_traversal_rejected(self):
        for layer in self.layers:
            layer["src/../../escape"] = "unsafe"
        with self.assertRaises(AssertionError):
            self.run_generator()

    def test_output_escape_rejected(self):
        self.pin["compositePatch"]["patchFile"] = "patches/../../escape.patch"
        with self.assertRaises(AssertionError):
            self.run_generator()


if __name__ == "__main__":
    unittest.main()
