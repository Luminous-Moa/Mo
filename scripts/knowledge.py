#!/usr/bin/env python3
"""Small, deterministic SQLite knowledge-graph manager.

The module intentionally uses only the Python standard library.  A caller may
override both the repository root and database path, which keeps tests and
experiments away from the live project graph.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import uuid
from typing import Any, Iterable
from urllib.parse import quote


SCHEMA_VERSION = 1
STATUSES = {"verified", "documented", "untested", "hypothesis", "historical"}
FORBIDDEN_PARTS = {".signing", "local.properties", ".git", "build", ".gradle"}
URL_RE = re.compile(r"https?://", re.IGNORECASE)


class KnowledgeError(Exception):
    """An expected, actionable command error."""


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def _connect(db_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(str(db_path))
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _require_database(db_path: Path) -> None:
    if not db_path.is_file():
        raise KnowledgeError(f"database does not exist: {db_path}; run init first")


def init_db(db_path: Path) -> None:
    db_path = Path(db_path)
    if db_path.exists():
        raise KnowledgeError(f"refusing to overwrite existing database: {db_path}")
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = _connect(db_path)
    try:
        connection.executescript(
            """
            CREATE TABLE meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE nodes (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT NOT NULL,
                status TEXT NOT NULL,
                evidence_json TEXT NOT NULL,
                path TEXT,
                symbol TEXT,
                file_sha256 TEXT,
                anchor_line INTEGER,
                payload_json TEXT NOT NULL
            );
            CREATE TABLE edges (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL REFERENCES nodes(id),
                target TEXT NOT NULL REFERENCES nodes(id),
                relation TEXT NOT NULL,
                summary TEXT NOT NULL,
                evidence_json TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE TABLE revisions (
                revision INTEGER PRIMARY KEY,
                session TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                changes_json TEXT NOT NULL,
                payload_hash TEXT NOT NULL
            );
            CREATE TABLE node_history (
                revision INTEGER NOT NULL REFERENCES revisions(revision),
                node_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (revision, node_id)
            );
            CREATE TABLE edge_history (
                revision INTEGER NOT NULL REFERENCES revisions(revision),
                edge_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (revision, edge_id)
            );
            """
        )
        connection.executemany(
            "INSERT INTO meta(key, value) VALUES (?, ?)",
            (("schema_version", str(SCHEMA_VERSION)), ("revision", "0")),
        )
        empty_hash = hashlib.sha256(_canonical({"nodes": [], "edges": []}).encode("utf-8")).hexdigest()
        connection.execute(
            "INSERT INTO revisions(revision, session, timestamp, changes_json, payload_hash) "
            "VALUES (0, ?, ?, ?, ?)",
            ("init", _utc_now(), _canonical({"nodes": [], "edges": []}), empty_hash),
        )
        connection.commit()
    except Exception:
        connection.close()
        try:
            db_path.unlink()
        except OSError:
            pass
        raise
    finally:
        try:
            connection.close()
        except Exception:
            pass


def _revision(connection: sqlite3.Connection) -> int:
    row = connection.execute("SELECT value FROM meta WHERE key = 'revision'").fetchone()
    if row is None:
        raise KnowledgeError("invalid database: missing meta revision")
    try:
        return int(row[0])
    except ValueError as exc:
        raise KnowledgeError("invalid database: non-integer meta revision") from exc


def _schema_version(connection: sqlite3.Connection) -> int:
    row = connection.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
    if row is None or row[0] != str(SCHEMA_VERSION):
        found = "missing" if row is None else row[0]
        raise KnowledgeError(f"unsupported schema version: {found}; expected {SCHEMA_VERSION}")
    return SCHEMA_VERSION


def _load_graph(connection: sqlite3.Connection) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    nodes = {
        row["id"]: json.loads(row["payload_json"])
        for row in connection.execute("SELECT id, payload_json FROM nodes ORDER BY id")
    }
    edges = {
        row["id"]: json.loads(row["payload_json"])
        for row in connection.execute("SELECT id, payload_json FROM edges ORDER BY id")
    }
    return nodes, edges


def _require_text(value: Any, label: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        qualifier = "non-empty " if nonempty else ""
        raise KnowledgeError(f"{label} must be a {qualifier}string")
    return value


def _reject_url(value: str, label: str) -> None:
    if URL_RE.search(value):
        raise KnowledgeError(f"{label} contains an external URL; URLs are allowed only in evidence")


def _normalize_evidence(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise KnowledgeError(f"{label} must be a list of non-empty strings")
    return list(value)


def _validate_repo_path(root: Path, raw_path: str, symbol: str | None) -> tuple[str, str, int | None]:
    _reject_url(raw_path, "node.path")
    supplied = Path(raw_path)
    if supplied.is_absolute():
        raise KnowledgeError(f"node.path must be repository-relative: {raw_path}")
    if any(part.casefold() in FORBIDDEN_PARTS for part in supplied.parts):
        raise KnowledgeError(f"node.path uses a forbidden private/build path: {raw_path}")
    root_resolved = root.resolve()
    candidate = (root_resolved / supplied).resolve()
    try:
        relative = candidate.relative_to(root_resolved)
    except ValueError as exc:
        raise KnowledgeError(f"node.path escapes repository root: {raw_path}") from exc
    if any(part.casefold() in FORBIDDEN_PARTS for part in relative.parts):
        raise KnowledgeError(
            f"node.path resolves through a forbidden private/build path: {relative.as_posix()}"
        )
    if not candidate.is_file():
        raise KnowledgeError(f"node.path does not exist as a file: {relative.as_posix()}")
    content = candidate.read_bytes()
    fingerprint = hashlib.sha256(content).hexdigest()
    anchor_line: int | None = None
    if symbol is not None:
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise KnowledgeError(f"node.path is not UTF-8 and cannot be searched for symbol: {relative.as_posix()}") from exc
        position = text.find(symbol)
        if position < 0:
            raise KnowledgeError(f"node.symbol is not an exact substring of {relative.as_posix()}: {symbol!r}")
        anchor_line = text.count("\n", 0, position) + 1
    return relative.as_posix(), fingerprint, anchor_line


def _normalize_node(value: Any, root: Path) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise KnowledgeError("each node must be an object")
    allowed = {"id", "kind", "title", "summary", "status", "evidence", "path", "symbol"}
    unknown = set(value) - allowed
    if unknown:
        raise KnowledgeError(f"node {value.get('id', '<unknown>')} has unknown fields: {', '.join(sorted(unknown))}")
    node: dict[str, Any] = {}
    for field in ("id", "kind", "title", "summary", "status"):
        node[field] = _require_text(value.get(field), f"node.{field}")
        _reject_url(node[field], f"node.{field}")
    if node["status"] not in STATUSES:
        raise KnowledgeError(f"node {node['id']} has invalid status {node['status']!r}")
    node["evidence"] = _normalize_evidence(value.get("evidence"), "node.evidence")
    path_value = value.get("path")
    symbol_value = value.get("symbol")
    if symbol_value is not None:
        symbol_value = _require_text(symbol_value, "node.symbol")
        _reject_url(symbol_value, "node.symbol")
        if path_value is None:
            raise KnowledgeError(f"node {node['id']} supplies symbol without path")
    if path_value is not None:
        path_value = _require_text(path_value, "node.path")
        normalized_path, fingerprint, anchor_line = _validate_repo_path(root, path_value, symbol_value)
        node["path"] = normalized_path
        if symbol_value is not None:
            node["symbol"] = symbol_value
        node["file_sha256"] = fingerprint
        node["anchor_line"] = anchor_line
    return node


def _normalize_edge(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise KnowledgeError("each edge must be an object")
    allowed = {"id", "source", "target", "relation", "summary", "evidence"}
    unknown = set(value) - allowed
    if unknown:
        raise KnowledgeError(f"edge {value.get('id', '<unknown>')} has unknown fields: {', '.join(sorted(unknown))}")
    edge: dict[str, Any] = {}
    for field in ("id", "source", "target", "relation", "summary"):
        edge[field] = _require_text(value.get(field), f"edge.{field}")
        _reject_url(edge[field], f"edge.{field}")
    edge["evidence"] = _normalize_evidence(value.get("evidence"), "edge.evidence")
    return edge


def _validate_existing_paths(nodes: Iterable[dict[str, Any]], root: Path) -> None:
    for node in nodes:
        if "path" not in node:
            continue
        # Revalidate containment, existence and the current anchor while retaining
        # the recorded fingerprint in the existing payload.
        _validate_repo_path(root, node["path"], node.get("symbol"))


def _read_change_file(change_file: Path) -> dict[str, Any]:
    try:
        data = json.loads(Path(change_file).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise KnowledgeError(f"cannot read change JSON {change_file}: {exc}") from exc
    if not isinstance(data, dict) or set(data) - {"nodes", "edges"}:
        raise KnowledgeError("change JSON must be an object containing only nodes and edges")
    if not isinstance(data.get("nodes", []), list) or not isinstance(data.get("edges", []), list):
        raise KnowledgeError("change JSON nodes and edges must be lists")
    return {"nodes": data.get("nodes", []), "edges": data.get("edges", [])}


def _validate_batch(
    data: dict[str, Any],
    root: Path,
    existing_nodes: dict[str, dict[str, Any]],
    existing_edges: dict[str, dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], list[str], list[str]]:
    incoming_nodes = [_normalize_node(item, root) for item in data["nodes"]]
    incoming_edges = [_normalize_edge(item) for item in data["edges"]]
    node_ids = [item["id"] for item in incoming_nodes]
    edge_ids = [item["id"] for item in incoming_edges]
    duplicate_nodes = sorted({item for item in node_ids if node_ids.count(item) > 1})
    duplicate_edges = sorted({item for item in edge_ids if edge_ids.count(item) > 1})
    if duplicate_nodes:
        raise KnowledgeError(f"duplicate node IDs in batch: {', '.join(duplicate_nodes)}")
    if duplicate_edges:
        raise KnowledgeError(f"duplicate edge IDs in batch: {', '.join(duplicate_edges)}")

    merged_nodes = dict(existing_nodes)
    merged_edges = dict(existing_edges)
    merged_nodes.update((item["id"], item) for item in incoming_nodes)
    merged_edges.update((item["id"], item) for item in incoming_edges)
    _validate_existing_paths(
        (node for node_id, node in existing_nodes.items() if node_id not in set(node_ids)), root
    )
    for edge in merged_edges.values():
        if edge["source"] not in merged_nodes:
            raise KnowledgeError(f"edge {edge['id']} references missing source node: {edge['source']}")
        if edge["target"] not in merged_nodes:
            raise KnowledgeError(f"edge {edge['id']} references missing target node: {edge['target']}")
    changed_nodes = [node_id for node_id in node_ids if existing_nodes.get(node_id) != merged_nodes[node_id]]
    changed_edges = [edge_id for edge_id in edge_ids if existing_edges.get(edge_id) != merged_edges[edge_id]]
    return merged_nodes, merged_edges, changed_nodes, changed_edges


def _backup_database(db_path: Path, next_revision: int) -> Path:
    backup_dir = db_path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"revision-{next_revision:06d}-{uuid.uuid4().hex[:12]}.sqlite3"
    source = _connect(db_path)
    target = sqlite3.connect(str(backup_path))
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    return backup_path


def apply_changes(
    db_path: Path,
    root: Path,
    change_file: Path,
    expected_revision: int,
    session: str,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    db_path, root = Path(db_path), Path(root)
    _require_database(db_path)
    if not isinstance(session, str) or not session.strip():
        raise KnowledgeError("--session must be non-empty")
    data = _read_change_file(change_file)
    connection = _connect(db_path)
    backup_path: Path | None = None
    try:
        connection.execute("BEGIN IMMEDIATE")
        _schema_version(connection)
        current_revision = _revision(connection)
        if current_revision != expected_revision:
            raise KnowledgeError(
                f"revision conflict: expected {expected_revision}, current revision is {current_revision}"
            )
        existing_nodes, existing_edges = _load_graph(connection)
        merged_nodes, merged_edges, changed_nodes, changed_edges = _validate_batch(
            data, root, existing_nodes, existing_edges
        )
        if not changed_nodes and not changed_edges:
            connection.rollback()
            return {
                "revision": current_revision,
                "changed": False,
                "dry_run": dry_run,
                "backup": None,
            }
        next_revision = current_revision + 1
        if dry_run:
            connection.rollback()
            return {
                "revision": current_revision,
                "would_revision": next_revision,
                "changed": True,
                "dry_run": True,
                "backup": None,
                "nodes": changed_nodes,
                "edges": changed_edges,
            }

        backup_path = _backup_database(db_path, next_revision)
        graph_payload = {
            "nodes": [merged_nodes[item] for item in sorted(merged_nodes)],
            "edges": [merged_edges[item] for item in sorted(merged_edges)],
        }
        payload_hash = hashlib.sha256(_canonical(graph_payload).encode("utf-8")).hexdigest()
        changes_payload = {"nodes": changed_nodes, "edges": changed_edges}
        connection.execute(
            "INSERT INTO revisions(revision, session, timestamp, changes_json, payload_hash) VALUES (?, ?, ?, ?, ?)",
            (next_revision, session.strip(), _utc_now(), _canonical(changes_payload), payload_hash),
        )
        for node_id in changed_nodes:
            if node_id in existing_nodes:
                connection.execute(
                    "INSERT INTO node_history(revision, node_id, payload_json) VALUES (?, ?, ?)",
                    (next_revision, node_id, _canonical(existing_nodes[node_id])),
                )
            node = merged_nodes[node_id]
            connection.execute(
                """
                INSERT INTO nodes(id, kind, title, summary, status, evidence_json, path, symbol,
                                  file_sha256, anchor_line, payload_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    kind=excluded.kind, title=excluded.title, summary=excluded.summary,
                    status=excluded.status, evidence_json=excluded.evidence_json,
                    path=excluded.path, symbol=excluded.symbol, file_sha256=excluded.file_sha256,
                    anchor_line=excluded.anchor_line, payload_json=excluded.payload_json
                """,
                (
                    node["id"], node["kind"], node["title"], node["summary"], node["status"],
                    _canonical(node["evidence"]), node.get("path"), node.get("symbol"),
                    node.get("file_sha256"), node.get("anchor_line"), _canonical(node),
                ),
            )
        for edge_id in changed_edges:
            if edge_id in existing_edges:
                connection.execute(
                    "INSERT INTO edge_history(revision, edge_id, payload_json) VALUES (?, ?, ?)",
                    (next_revision, edge_id, _canonical(existing_edges[edge_id])),
                )
            edge = merged_edges[edge_id]
            connection.execute(
                """
                INSERT INTO edges(id, source, target, relation, summary, evidence_json, payload_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    source=excluded.source, target=excluded.target, relation=excluded.relation,
                    summary=excluded.summary, evidence_json=excluded.evidence_json,
                    payload_json=excluded.payload_json
                """,
                (
                    edge["id"], edge["source"], edge["target"], edge["relation"], edge["summary"],
                    _canonical(edge["evidence"]), _canonical(edge),
                ),
            )
        connection.execute("UPDATE meta SET value = ? WHERE key = 'revision'", (str(next_revision),))
        connection.commit()
        return {
            "revision": next_revision,
            "changed": True,
            "dry_run": False,
            "backup": str(backup_path),
            "nodes": changed_nodes,
            "edges": changed_edges,
        }
    except Exception:
        try:
            connection.rollback()
        except sqlite3.Error:
            pass
        raise
    finally:
        connection.close()


def database_status(db_path: Path) -> dict[str, Any]:
    _require_database(Path(db_path))
    connection = _connect(Path(db_path))
    try:
        connection.execute("BEGIN")
        schema = _schema_version(connection)
        revision = _revision(connection)
        nodes = connection.execute("SELECT count(*) FROM nodes").fetchone()[0]
        edges = connection.execute("SELECT count(*) FROM edges").fetchone()[0]
        revision_row = connection.execute(
            "SELECT session, timestamp, payload_hash FROM revisions WHERE revision = ?", (revision,)
        ).fetchone()
        if revision_row is None:
            raise KnowledgeError(f"invalid database: missing revision record {revision}")
        return {
            "schema_version": schema,
            "revision": revision,
            "latest_session": revision_row["session"],
            "updated_at": revision_row["timestamp"],
            "payload_hash": revision_row["payload_hash"],
            "nodes": nodes,
            "edges": edges,
        }
    finally:
        if connection.in_transaction:
            connection.rollback()
        connection.close()


def check_database(db_path: Path, root: Path) -> dict[str, Any]:
    _require_database(Path(db_path))
    connection = _connect(Path(db_path))
    errors: list[str] = []
    warnings: list[str] = []
    try:
        connection.execute("BEGIN")
        try:
            _schema_version(connection)
            revision = _revision(connection)
        except KnowledgeError as exc:
            errors.append(str(exc))
            revision = -1
        integrity = connection.execute("PRAGMA integrity_check").fetchall()
        for row in integrity:
            if row[0] != "ok":
                errors.append(f"integrity: {row[0]}")
        for row in connection.execute("PRAGMA foreign_key_check"):
            errors.append(f"foreign key: table={row[0]} rowid={row[1]} parent={row[2]}")
        try:
            nodes, _ = _load_graph(connection)
        except (json.JSONDecodeError, KeyError) as exc:
            errors.append(f"invalid stored payload: {exc}")
            nodes = {}
        for node_id, node in nodes.items():
            raw_path = node.get("path")
            if raw_path is None:
                continue
            try:
                normalized, fingerprint, anchor_line = _validate_repo_path(
                    Path(root), raw_path, node.get("symbol")
                )
            except (KnowledgeError, OSError) as exc:
                errors.append(f"node {node_id}: {exc}")
                continue
            if fingerprint != node.get("file_sha256"):
                warnings.append(f"node {node_id}: stale fingerprint for {normalized}")
            if node.get("symbol") is not None and anchor_line != node.get("anchor_line"):
                warnings.append(
                    f"node {node_id}: anchor moved in {normalized} from line {node.get('anchor_line')} to {anchor_line}"
                )
        return {"ok": not errors, "revision": revision, "errors": errors, "warnings": warnings}
    finally:
        if connection.in_transaction:
            connection.rollback()
        connection.close()


def search_graph(db_path: Path, query: str) -> list[dict[str, Any]]:
    _require_database(Path(db_path))
    query = _require_text(query, "query").casefold()
    connection = _connect(Path(db_path))
    try:
        connection.execute("BEGIN")
        nodes, edges = _load_graph(connection)
        matches: list[dict[str, Any]] = []
        for item_type, collection in (("node", nodes), ("edge", edges)):
            for item_id in sorted(collection):
                item = collection[item_id]
                if query in _canonical(item).casefold():
                    matches.append({"type": item_type, **item})
        return matches
    finally:
        if connection.in_transaction:
            connection.rollback()
        connection.close()


def show_item(db_path: Path, item_id: str) -> dict[str, Any]:
    _require_database(Path(db_path))
    connection = _connect(Path(db_path))
    try:
        connection.execute("BEGIN")
        row = connection.execute("SELECT payload_json FROM nodes WHERE id = ?", (item_id,)).fetchone()
        if row is not None:
            node = json.loads(row[0])
            incoming = [
                json.loads(edge[0])
                for edge in connection.execute(
                    "SELECT payload_json FROM edges WHERE target = ? ORDER BY id", (item_id,)
                )
            ]
            outgoing = [
                json.loads(edge[0])
                for edge in connection.execute(
                    "SELECT payload_json FROM edges WHERE source = ? ORDER BY id", (item_id,)
                )
            ]
            return {"type": "node", **node, "incoming": incoming, "outgoing": outgoing}
        row = connection.execute("SELECT payload_json FROM edges WHERE id = ?", (item_id,)).fetchone()
        if row is not None:
            return {"type": "edge", **json.loads(row[0])}
    finally:
        if connection.in_transaction:
            connection.rollback()
        connection.close()
    raise KnowledgeError(f"no node or edge with ID: {item_id}")


def _mermaid_label(value: str) -> str:
    clean = " ".join(value.replace("\x00", "").split())
    return (
        clean.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("[", "&#91;")
        .replace("]", "&#93;")
        .replace("{", "&#123;")
        .replace("}", "&#125;")
    )


def _mermaid(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> str:
    aliases = {node["id"]: f"n{index}" for index, node in enumerate(nodes)}
    lines = ["flowchart LR"]
    for node in nodes:
        label = _mermaid_label(f"{node['title']} ({node['status']})")
        lines.append(f'  {aliases[node["id"]]}["{label}"]')
    for edge in edges:
        label = _mermaid_label(edge["relation"])
        lines.append(f'  {aliases[edge["source"]]} -->|"{label}"| {aliases[edge["target"]]}')
    return "\n".join(lines) + "\n"


def _source_link(root: Path, export_dir: Path, node: dict[str, Any]) -> str | None:
    if "path" not in node:
        return None
    target = root.resolve() / node["path"]
    relative = Path(os.path.relpath(target, export_dir.resolve())).as_posix()
    suffix = f"#L{node['anchor_line']}" if node.get("anchor_line") else ""
    return quote(relative, safe="/.:#-") + suffix


def _node_markdown(root: Path, export_dir: Path, node: dict[str, Any]) -> list[str]:
    title = node["title"].replace("\n", " ")
    lines = [f"### {title} (`{node['id']}`)", "", f"Status: `{node['status']}`. Kind: `{node['kind']}`.", "", node["summary"], ""]
    link = _source_link(root, export_dir, node)
    if link:
        label = node["path"] + (f":{node['anchor_line']}" if node.get("anchor_line") else "")
        lines.extend([f"Source: [{label}]({link})", ""])
    if node["evidence"]:
        lines.append("Evidence:")
        lines.append("")
        lines.extend(f"- {item}" for item in node["evidence"])
        lines.append("")
    return lines


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def export_graph(db_path: Path, root: Path, out_dir: Path) -> Path:
    _require_database(Path(db_path))
    connection = _connect(Path(db_path))
    try:
        connection.execute("BEGIN")
        _schema_version(connection)
        revision = _revision(connection)
        nodes_by_id, edges_by_id = _load_graph(connection)
    finally:
        if connection.in_transaction:
            connection.rollback()
        connection.close()
    nodes = [nodes_by_id[item] for item in sorted(nodes_by_id)]
    edges = [edges_by_id[item] for item in sorted(edges_by_id)]
    revision_dir = Path(out_dir) / f"revision-{revision:06d}"
    revision_dir.mkdir(parents=True, exist_ok=True)
    state = {"schema_version": SCHEMA_VERSION, "revision": revision, "nodes": nodes, "edges": edges}
    mermaid = _mermaid(nodes, edges)
    graph_lines = [f"# Knowledge graph revision {revision}", "", "```mermaid", mermaid.rstrip(), "```", ""]
    for node in nodes:
        graph_lines.extend(_node_markdown(Path(root), revision_dir, node))

    project_ids = {node["id"] for node in nodes if node["kind"].casefold() == "project"}
    linked_ids = set(project_ids)
    project_edges = []
    for edge in edges:
        if edge["source"] in project_ids or edge["target"] in project_ids:
            linked_ids.update((edge["source"], edge["target"]))
            project_edges.append(edge)
    overview_lines = [f"# Project overview revision {revision}", ""]
    if not project_ids:
        overview_lines.extend(["No nodes with kind `project` are recorded.", ""])
    for node in nodes:
        if node["id"] in linked_ids:
            overview_lines.extend(_node_markdown(Path(root), revision_dir, node))
    if project_edges:
        overview_lines.extend(["## Project links", ""])
        overview_lines.extend(
            f"- `{edge['source']}` — **{edge['relation']}** → `{edge['target']}`: {edge['summary']}"
            for edge in project_edges
        )
        overview_lines.append("")

    _atomic_write(revision_dir / "graph.json", json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    _atomic_write(revision_dir / "graph.mmd", mermaid)
    _atomic_write(revision_dir / "graph.md", "\n".join(graph_lines))
    _atomic_write(revision_dir / "overview.md", "\n".join(overview_lines))
    return revision_dir


def _default_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage the project's SQLite knowledge graph")
    parser.add_argument("--root", type=Path, default=_default_root(), help="repository root")
    parser.add_argument("--db", type=Path, help="database path (default: ROOT/knowledge/graph.sqlite3)")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("init", help="create a new empty graph database")
    subparsers.add_parser("status", help="show schema, revision and graph counts")
    subparsers.add_parser("check", help="check integrity, references and source provenance")
    search_parser = subparsers.add_parser("search", help="search node and edge payloads")
    search_parser.add_argument("query")
    show_parser = subparsers.add_parser("show", help="show a node or edge by ID")
    show_parser.add_argument("id")
    apply_parser = subparsers.add_parser("apply", help="atomically merge a JSON change batch")
    apply_parser.add_argument("json_file", type=Path)
    apply_parser.add_argument("--expect-revision", type=int, required=True)
    apply_parser.add_argument("--session", required=True)
    apply_parser.add_argument("--dry-run", action="store_true")
    export_parser = subparsers.add_parser("export", help="write deterministic graph artifacts")
    export_parser.add_argument("--out", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    root = args.root.resolve()
    db_path = args.db.resolve() if args.db else root / "knowledge" / "graph.sqlite3"
    try:
        if args.command == "init":
            init_db(db_path)
            result: Any = {"initialized": str(db_path), "revision": 0}
        elif args.command == "status":
            result = database_status(db_path)
        elif args.command == "check":
            result = check_database(db_path, root)
        elif args.command == "search":
            result = search_graph(db_path, args.query)
        elif args.command == "show":
            result = show_item(db_path, args.id)
        elif args.command == "apply":
            result = apply_changes(
                db_path, root, args.json_file, args.expect_revision, args.session, dry_run=args.dry_run
            )
        elif args.command == "export":
            exported = export_graph(db_path, root, args.out)
            result = {"exported": str(exported), "revision": int(exported.name.removeprefix("revision-"))}
        else:
            parser.error(f"unknown command: {args.command}")
            return 2
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        if args.command == "check" and not result["ok"]:
            return 1
        return 0
    except (KnowledgeError, OSError, sqlite3.Error) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
