from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "knowledge.py"
SPEC = importlib.util.spec_from_file_location("weatherair_knowledge", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
knowledge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(knowledge)


class KnowledgeToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "src").mkdir()
        (self.root / "src" / "sample.py").write_text(
            "def alpha():\n    return 1\n", encoding="utf-8"
        )
        self.db = self.root / "knowledge" / "graph.sqlite3"
        knowledge.init_db(self.db)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_change(self, name: str, nodes=None, edges=None) -> Path:
        path = self.root / name
        path.write_text(
            json.dumps({"nodes": nodes or [], "edges": edges or []}), encoding="utf-8"
        )
        return path

    def node(self, node_id="node.alpha", **updates):
        value = {
            "id": node_id,
            "kind": "code",
            "title": "Alpha",
            "summary": "Alpha implementation",
            "status": "verified",
            "evidence": ["unit fixture"],
            "path": "src/sample.py",
            "symbol": "def alpha():",
        }
        value.update(updates)
        return value

    def apply(self, change: Path, revision=0, session="test"):
        return knowledge.apply_changes(self.db, self.root, change, revision, session)

    def test_init_refuses_collision(self):
        status = knowledge.database_status(self.db)
        self.assertEqual(status["latest_session"], "init")
        self.assertTrue(status["updated_at"])
        self.assertEqual(len(status["payload_hash"]), 64)
        with self.assertRaisesRegex(knowledge.KnowledgeError, "refusing to overwrite"):
            knowledge.init_db(self.db)

    def test_dry_run_is_immutable_and_creates_no_backup(self):
        change = self.write_change("change.json", [self.node()])
        result = knowledge.apply_changes(
            self.db, self.root, change, 0, "dry", dry_run=True
        )
        self.assertTrue(result["changed"])
        self.assertEqual(knowledge.database_status(self.db)["revision"], 0)
        self.assertEqual(knowledge.database_status(self.db)["nodes"], 0)
        self.assertFalse((self.db.parent / "backups").exists())

    def test_expected_revision_conflict_is_immutable(self):
        change = self.write_change("change.json", [self.node()])
        with self.assertRaisesRegex(knowledge.KnowledgeError, "revision conflict"):
            knowledge.apply_changes(self.db, self.root, change, 9, "conflict")
        self.assertEqual(knowledge.database_status(self.db)["revision"], 0)

    def test_invalid_edge_batch_is_atomic(self):
        change = self.write_change(
            "invalid.json", [self.node()],
            [{"id": "edge.bad", "source": "node.alpha", "target": "missing",
              "relation": "calls", "summary": "bad ref", "evidence": []}],
        )
        with self.assertRaisesRegex(knowledge.KnowledgeError, "missing target"):
            self.apply(change)
        self.assertEqual(knowledge.database_status(self.db)["nodes"], 0)
        self.assertEqual(knowledge.database_status(self.db)["revision"], 0)

    def test_update_preserves_history_and_creates_backups(self):
        first = self.write_change("first.json", [self.node()])
        one = self.apply(first)
        second = self.write_change(
            "second.json", [self.node(summary="Updated implementation")]
        )
        two = self.apply(second, revision=1)
        self.assertEqual((one["revision"], two["revision"]), (1, 2))
        backups = sorted((self.db.parent / "backups").glob("*.sqlite3"))
        self.assertEqual(len(backups), 2)
        connection = sqlite3.connect(self.db)
        try:
            history = connection.execute(
                "SELECT payload_json FROM node_history WHERE revision=2 AND node_id='node.alpha'"
            ).fetchone()
        finally:
            connection.close()
        self.assertIsNotNone(history)
        self.assertEqual(json.loads(history[0])["summary"], "Alpha implementation")
        connection = sqlite3.connect(backups[-1])
        try:
            self.assertEqual(connection.execute("SELECT value FROM meta WHERE key='revision'").fetchone()[0], "1")
        finally:
            connection.close()

    def test_missing_edge_path_and_anchor_rejected(self):
        missing_path = self.write_change("missing-path.json", [self.node(path="src/no.py")])
        with self.assertRaisesRegex(knowledge.KnowledgeError, "does not exist"):
            self.apply(missing_path)
        missing_anchor = self.write_change("missing-anchor.json", [self.node(symbol="def nope")])
        with self.assertRaisesRegex(knowledge.KnowledgeError, "not an exact substring"):
            self.apply(missing_anchor)
        missing_edge = self.write_change(
            "missing-edge.json", [],
            [{"id": "e", "source": "x", "target": "y", "relation": "r",
              "summary": "s", "evidence": []}],
        )
        with self.assertRaisesRegex(knowledge.KnowledgeError, "missing source"):
            self.apply(missing_edge)

    def test_path_traversal_and_credentials_paths_rejected(self):
        outside = self.root.parent / "outside.txt"
        outside.write_text("secret", encoding="utf-8")
        traversal = self.write_change("traversal.json", [self.node(path="../outside.txt", symbol=None)])
        with self.assertRaisesRegex(knowledge.KnowledgeError, "escapes repository"):
            self.apply(traversal)
        for forbidden in ("local.properties", ".signing/key.txt", ".git/config", "app/build/x"):
            change = self.write_change("forbidden.json", [self.node(path=forbidden, symbol=None)])
            with self.subTest(forbidden=forbidden):
                with self.assertRaisesRegex(knowledge.KnowledgeError, "forbidden"):
                    self.apply(change)

    def test_resolved_symlink_to_forbidden_path_is_rejected(self):
        private_dir = self.root / ".signing"
        private_dir.mkdir()
        (private_dir / "key.txt").write_text("private", encoding="utf-8")
        alias = self.root / "source-alias"
        try:
            os.symlink(private_dir, alias, target_is_directory=True)
        except (NotImplementedError, OSError) as exc:
            self.skipTest(f"directory symlinks unavailable: {exc}")
        change = self.write_change(
            "symlink.json", [self.node(path="source-alias/key.txt", symbol=None)]
        )
        with self.assertRaisesRegex(knowledge.KnowledgeError, "resolves through a forbidden"):
            self.apply(change)

    def test_search_and_show(self):
        project = self.node(
            "project.weather", kind="project", title="Weather Air", summary="Forecast app",
            path=None, symbol=None, status="documented"
        )
        # Optional fields must be omitted rather than serialized as null.
        project.pop("path")
        project.pop("symbol")
        edge = {"id": "edge.owns", "source": "project.weather", "target": "node.alpha",
                "relation": "owns", "summary": "Project owns alpha", "evidence": ["fixture"]}
        change = self.write_change("graph.json", [project, self.node()], [edge])
        self.apply(change)
        matches = knowledge.search_graph(self.db, "forecast")
        self.assertEqual([item["id"] for item in matches], ["project.weather"])
        shown = knowledge.show_item(self.db, "edge.owns")
        self.assertEqual(shown["type"], "edge")
        self.assertEqual(shown["relation"], "owns")
        project_shown = knowledge.show_item(self.db, "project.weather")
        self.assertEqual([edge["id"] for edge in project_shown["outgoing"]], ["edge.owns"])
        self.assertEqual(project_shown["incoming"], [])
        alpha_shown = knowledge.show_item(self.db, "node.alpha")
        self.assertEqual([edge["id"] for edge in alpha_shown["incoming"]], ["edge.owns"])

    def test_unchanged_reapply_is_noop(self):
        change = self.write_change("same.json", [self.node()])
        self.apply(change)
        backup_count = len(list((self.db.parent / "backups").glob("*.sqlite3")))
        result = self.apply(change, revision=1, session="same")
        self.assertFalse(result["changed"])
        self.assertEqual(knowledge.database_status(self.db)["revision"], 1)
        self.assertEqual(len(list((self.db.parent / "backups").glob("*.sqlite3"))), backup_count)

    def test_export_repeat_and_revision_correspondence(self):
        node = self.node("project.weather", kind="project", title='Weather [Air] "App"', status="documented")
        change = self.write_change("export-change.json", [node])
        self.apply(change)
        out = self.root / "exports"
        first = knowledge.export_graph(self.db, self.root, out)
        second = knowledge.export_graph(self.db, self.root, out)
        self.assertEqual(first, second)
        self.assertEqual(first.name, "revision-000001")
        self.assertEqual({item.name for item in first.iterdir()}, {"graph.json", "graph.mmd", "graph.md", "overview.md"})
        state = json.loads((first / "graph.json").read_text(encoding="utf-8"))
        self.assertEqual(state["revision"], 1)
        mermaid = (first / "graph.mmd").read_text(encoding="utf-8")
        self.assertIn("n0", mermaid)
        self.assertIn("&quot;", mermaid)
        self.assertIn("Source:", (first / "overview.md").read_text(encoding="utf-8"))
        self.assertNotIn("node.alpha", mermaid)

    def test_export_uses_one_wal_snapshot_during_concurrent_commit(self):
        first = self.write_change("initial.json", [self.node()])
        self.apply(first)
        connection = sqlite3.connect(self.db)
        try:
            self.assertEqual(connection.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        finally:
            connection.close()
        update = self.write_change("concurrent.json", [self.node(summary="Committed revision two")])
        original_load_graph = knowledge._load_graph
        writer_errors = []
        triggered = False
        export_thread = threading.current_thread()

        def load_graph_after_commit(connection):
            nonlocal triggered
            if threading.current_thread() is export_thread and not triggered:
                triggered = True

                def writer():
                    try:
                        knowledge.apply_changes(self.db, self.root, update, 1, "concurrent-writer")
                    except Exception as exc:  # Captured and asserted in the test thread.
                        writer_errors.append(exc)

                thread = threading.Thread(target=writer)
                thread.start()
                thread.join(timeout=10)
                self.assertFalse(thread.is_alive(), "concurrent writer did not finish")
            return original_load_graph(connection)

        knowledge._load_graph = load_graph_after_commit
        try:
            exported = knowledge.export_graph(self.db, self.root, self.root / "concurrent-export")
        finally:
            knowledge._load_graph = original_load_graph
        self.assertEqual(writer_errors, [])
        self.assertTrue(triggered)
        self.assertEqual(exported.name, "revision-000001")
        state = json.loads((exported / "graph.json").read_text(encoding="utf-8"))
        self.assertEqual(state["revision"], 1)
        self.assertEqual(state["nodes"][0]["summary"], "Alpha implementation")
        self.assertEqual(knowledge.database_status(self.db)["revision"], 2)

    def test_check_warns_on_stale_file_and_errors_on_missing_anchor(self):
        change = self.write_change("check-change.json", [self.node()])
        self.apply(change)
        source = self.root / "src" / "sample.py"
        source.write_text("# shifted\ndef alpha():\n    return 2\n", encoding="utf-8")
        result = knowledge.check_database(self.db, self.root)
        self.assertTrue(result["ok"])
        self.assertTrue(any("stale fingerprint" in item for item in result["warnings"]))
        self.assertTrue(any("anchor moved" in item for item in result["warnings"]))
        source.write_text("def beta():\n    return 2\n", encoding="utf-8")
        result = knowledge.check_database(self.db, self.root)
        self.assertFalse(result["ok"])
        self.assertTrue(any("not an exact substring" in item for item in result["errors"]))


if __name__ == "__main__":
    unittest.main()
