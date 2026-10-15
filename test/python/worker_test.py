import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "python" / "bridge_worker.py"
sys.path.insert(0, str(ROOT))
from python.bridge_worker import Task, TaskError, execute, health  # noqa: E402


class WorkerTests(unittest.TestCase):
    def test_health_and_hash(self):
        self.assertTrue(health()["ok"])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            file = root / "a.txt"
            file.write_text("hello", encoding="utf-8")
            result = execute(Task.parse({"id": "1", "op": "hash_file", "path": str(file)}), [root])
            self.assertEqual(result["result"]["bytes"], 5)
            self.assertEqual(len(result["result"]["sha256"]), 64)

    def test_root_escape_and_code_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(TaskError):
                Task.parse({"id": "x", "op": "exec", "path": str(root)})
            with self.assertRaises(TaskError):
                execute(Task.parse({"id": "x", "op": "read_text", "path": str(root.parent / "outside")}), [root])

    def test_cli_health(self):
        completed = subprocess.run([sys.executable, str(WORKER), "--health"], capture_output=True, text=True, check=True)
        self.assertTrue(json.loads(completed.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
