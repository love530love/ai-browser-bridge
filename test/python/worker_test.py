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

    def test_json_and_csv_round_trip_stays_in_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            json_path = root / "out" / "data.json"
            csv_path = root / "out" / "data.csv"
            rows = [{"name": "Ada", "score": 10}, {"name": "Lin", "score": 9}]
            execute(Task.parse({"id": "j", "op": "write_json", "path": str(json_path), "value": {"rows": rows}}), [root])
            loaded = execute(Task.parse({"id": "jr", "op": "read_json", "path": str(json_path)}), [root])
            self.assertEqual(loaded["result"]["value"]["rows"][0]["name"], "Ada")
            execute(Task.parse({"id": "c", "op": "write_csv", "path": str(csv_path), "headers": ["name", "score"], "rows": rows}), [root])
            parsed = execute(Task.parse({"id": "cr", "op": "read_csv", "path": str(csv_path)}), [root])
            self.assertEqual(parsed["result"]["headers"], ["name", "score"])
            self.assertEqual(parsed["result"]["rows"][1]["score"], "9")

    def test_structured_limits_and_write_escape(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(TaskError):
                Task.parse({"id": "x", "op": "write_csv", "path": str(root / "x"), "rows": "not-a-list"})
            with self.assertRaises(TaskError):
                execute(Task.parse({"id": "x", "op": "write_json", "path": str(root.parent / "escape.json"), "value": {}}), [root])


if __name__ == "__main__":
    unittest.main()
