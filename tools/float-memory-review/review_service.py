"""Ombre add-on: durable review intents and content revisions, not a second vault.

Standard-library core; Starlette is imported only by register() in the Ombre host.
Supported concurrency: one Ombre process, coordinated BucketManager writers.
External file editors, bulk restore/import and other processes require maintenance mode.
"""
from __future__ import annotations

import asyncio
import functools
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
from datetime import datetime, timezone
from uuid import uuid4
from float_orbis_import import OrbisImporter

PROTOCOL = "float-review/v2"
ID = re.compile(r"[A-Za-z0-9._-]{1,160}\Z")
REVISION = re.compile(r"[0-9a-f]{64}\Z")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]")


class ReviewError(Exception):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.status = code, status


def packed(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str, allow_nan=False)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def valid_id(value) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value) or value in (".", ".."):
        raise ReviewError("invalid_id", "记忆 ID 无效。", 400)
    return value


def content_text(value) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 12000 or CONTROL.search(value):
        raise ReviewError("invalid_content", "正文需为 1–12000 字符，且不能含危险控制字符。", 400)
    return value


def snapshot(bucket, *, include_deleted=False) -> dict:
    if not bucket or (bucket.get("metadata", {}).get("deleted_at") and not include_deleted):
        raise ReviewError("not_found", "记忆不存在或已移除。", 404)
    return json.loads(packed({"id": bucket["id"], "content": bucket["content"], "metadata": bucket["metadata"]}))


def revision(bucket: dict, *, include_deleted=False) -> str:
    value = snapshot(bucket, include_deleted=include_deleted)
    # Recall bookkeeping is not a factual edit and must not make an open
    # correction conflict. All content and other metadata remain versioned.
    value["metadata"].pop("last_active", None)
    value["metadata"].pop("activation_count", None)
    return hashlib.sha256(packed(value).encode()).hexdigest()


class WriterLock:
    """Reentrant per-task lock, also installed around coordinated native writers."""
    def __init__(self):
        self.lock = asyncio.Lock()
        self.owner = None
        self.depth = 0

    async def __aenter__(self):
        task = asyncio.current_task()
        if self.owner is not task:
            await self.lock.acquire()
            self.owner = task
        self.depth += 1
        return self

    async def __aexit__(self, *_):
        self.depth -= 1
        if not self.depth:
            self.owner = None
            self.lock.release()


class ReviewService:
    def __init__(self, manager, vault: str | Path, surface_policy=None):
        self.manager = manager
        self.surface_policy = surface_policy
        self.writer = WriterLock()
        self.originals = {}
        self.latent_factory = None
        self.latent_index = None
        self.latent_fingerprint = None
        self.latent_mode = "lexical-graph-v1"
        self.latent_semantic = None
        if os.environ.get("FLOAT_MEMORY_LATENT_ENABLED") == "true":
            from float_latent_vendor import MemoryIndex
            self.latent_factory = MemoryIndex
            self.latent_mode = os.environ.get("FLOAT_MEMORY_LATENT_MODE") or "lexical-graph-v1"
            if self.latent_mode not in ("lexical-graph-v1", "semantic-hybrid-v1"):
                raise ValueError("Unsupported Float Latent mode")
            if self.latent_mode == "semantic-hybrid-v1":
                from float_latent_semantic import ConfiguredEmbeddingProvider, SemanticRecall
                self.latent_semantic = SemanticRecall(ConfiguredEmbeddingProvider())
        root = Path(vault).resolve()
        directory = root / ".float-review"
        if directory.is_symlink():
            raise RuntimeError("Review state directory cannot be a symlink")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        self.process_lock = open(directory / "writer.lock", "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.process_lock.seek(0)
                self.process_lock.write(b"0")
                self.process_lock.flush()
                self.process_lock.seek(0)
                msvcrt.locking(self.process_lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.process_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, ImportError):
            self.process_lock.close()
            raise RuntimeError("Only one review-enabled Ombre process may own this vault") from None
        path = directory / "review.sqlite3"
        if path.is_symlink():
            self.process_lock.close()
            raise RuntimeError("Review database cannot be a symlink")
        self.db = sqlite3.connect(path, isolation_level=None)
        os.chmod(path, 0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL, version INTEGER NOT NULL, review_required INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS candidates (
                id TEXT PRIMARY KEY, client_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
                kind TEXT NOT NULL, target_id TEXT NOT NULL, base_revision TEXT NOT NULL,
                content TEXT NOT NULL, source TEXT NOT NULL, before_json TEXT,
                expected_json TEXT, state TEXT NOT NULL, version INTEGER NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result_revision TEXT
            );
            CREATE TABLE IF NOT EXISTS history (
                id TEXT PRIMARY KEY, bucket_id TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL,
                before_revision TEXT NOT NULL, after_revision TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS history_by_bucket ON history(bucket_id);
            CREATE INDEX IF NOT EXISTS candidates_by_state ON candidates(state,created_at);
            CREATE TABLE IF NOT EXISTS management (
                id TEXT PRIMARY KEY, client_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
                target_id TEXT NOT NULL, operation TEXT NOT NULL, before_json TEXT NOT NULL,
                expected_json TEXT NOT NULL, after_json TEXT, state TEXT NOT NULL, at TEXT NOT NULL
            );
        """)
        if "review_required" not in {row[1] for row in self.db.execute("PRAGMA table_info(policy)")}:
            self.db.execute("ALTER TABLE policy ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0")
        self.db.execute("INSERT OR IGNORE INTO policy(id,paused,version,review_required) VALUES(1,0,1,0)")
        self.orbis = OrbisImporter(self, ReviewError, revision, packed)
        from float_consolidation import Consolidation
        self.consolidation = Consolidation(self, ReviewError, revision)
        from float_workspaces import Workspaces
        self.workspaces = Workspaces(self.db, self.writer, ReviewError)
        from float_private_spaces import PrivateSpaces
        self.private_spaces = PrivateSpaces(self.db, self.writer, ReviewError)
        # Native writers in this process participate in CAS serialization. They
        # retain their existing authorization/review semantics (see README).
        for name in ("create", "update", "delete", "restore", "purge", "archive", "touch", "touch_many", "set_anchor"):
            original = getattr(manager, name, None)
            if original is None:
                continue
            self.originals[name] = original

            @functools.wraps(original)
            async def coordinated(*args, _fn=original, _name=name, **kwargs):
                async with self.writer:
                    if _name in ("create", "update", "delete", "restore", "purge", "archive", "set_anchor"):
                        self.latent_index = None
                        self.latent_fingerprint = None
                        if self.latent_semantic:
                            self.latent_semantic.invalidate()
                    return await _fn(*args, **kwargs)

            setattr(manager, name, coordinated)

    def close(self):
        if self.latent_semantic:
            self.latent_semantic.stop()
        for name, original in self.originals.items():
            setattr(self.manager, name, original)
        self.db.close()
        self.process_lock.close()

    def policy(self):
        row = self.db.execute("SELECT paused,version,review_required FROM policy WHERE id=1").fetchone()
        return {"paused": bool(row["paused"]), "reviewRequired": bool(row["review_required"]), "version": row["version"]}

    def check_writable(self):
        if self.policy()["paused"]:
            raise ReviewError("paused", "共享记忆写入已暂停，待确认内容仍保留。")

    async def set_policy(self, paused, version, review_required=None):
        if not isinstance(paused, bool) or type(version) is not int or (review_required is not None and not isinstance(review_required, bool)):
            raise ReviewError("invalid_policy", "写入开关参数无效。", 400)
        async with self.writer:
            required = self.policy()["reviewRequired"] if review_required is None else review_required
            result = self.db.execute("UPDATE policy SET paused=?,review_required=?,version=version+1 WHERE id=1 AND version=?", (int(paused), int(required), version))
            if not result.rowcount:
                raise ReviewError("conflict", "共享写入开关已在别处变更，请刷新。")
            return self.policy()

    async def detail(self, target_id):
        async with self.writer:
            entry = snapshot(await self.manager.get(valid_id(target_id)))
            return self._view(entry)

    def _view(self, raw):
        row = self.db.execute("SELECT source FROM history WHERE bucket_id=? AND before_json IS NULL ORDER BY rowid LIMIT 1", (raw["id"],)).fetchone()
        last = self.db.execute("SELECT at,after_revision FROM history WHERE bucket_id=? ORDER BY rowid DESC LIMIT 1", (raw["id"],)).fetchone()
        current_revision = revision(raw)
        return {**raw, "revision": current_revision, "provenance": json.loads(row["source"]) if row else {}, "modifiedAt": last["at"] if last and last["after_revision"] == current_revision else ""}

    async def _canonical_values(self, query=None):
        """Caller holds the writer lock; every view comes from current native files."""
        buckets = await self.manager.search(query, limit=20) if query else await self.manager.list_all(include_archive=False)
        entries = []
        for item in buckets:
            current = await self.manager.get(item["id"])
            if not current:
                continue
            meta = current.get("metadata", {})
            hidden = meta.get("dont_surface")
            hidden = hidden.strip().lower() in ("1", "true", "yes", "on") if isinstance(hidden, str) else bool(hidden)
            if str(meta.get("type") or "dynamic").strip().lower() not in ("dynamic", "permanent") or hidden or meta.get("deleted_at"):
                continue
            if self.surface_policy and not self.surface_policy.evaluate_bucket(current, mode="importance").allowed:
                continue
            entries.append(self._view(snapshot(current)))
        unique = {}
        for entry in entries:
            key = entry["content"].strip()
            if key and (key not in unique or entry["metadata"].get("type") == "permanent"):
                unique[key] = entry
        return list(unique.values())

    async def _refresh_semantic(self):
        async with self.writer:
            return await self._canonical_values()

    async def memories(self, query=None, engine="ombre"):
        """Active canonical facts for Float automation; drafts are never queried."""
        if query is not None and (not isinstance(query, str) or not query.strip() or len(query) > 500):
            raise ReviewError("invalid_query", "检索词需为 1–500 字符。", 400)
        if engine not in ("ombre", "latent"):
            raise ReviewError("invalid_request", "召回方式无效。", 400)
        if engine == "latent" and not self.latent_factory:
            raise ReviewError("latent_unavailable", "Latent 派生召回尚未启用，没有改用其他来源。", 501)
        if query and engine == "latent" and self.latent_semantic:
            from float_latent_semantic import SemanticError
            values = await self._refresh_semantic()
            try:
                return await self.latent_semantic.retrieve(query, values, self._refresh_semantic)
            except SemanticError as error:
                raise ReviewError(error.code, str(error), 409 if error.code == "conflict" else 503) from None
        async with self.writer:
            values = await self._canonical_values(query if engine == "ombre" else None)
            if query and engine == "latent":
                if len(values) > 2000 or sum(len(value["content"]) for value in values) > 2_000_000:
                    raise ReviewError("latent_capacity", "当前记忆量超过本地 Latent 派生检索上限，请选择 Ombre 召回。", 503)
                fingerprint = hashlib.sha256(packed(sorted((value["id"], value["revision"]) for value in values)).encode()).hexdigest()
                try:
                    if self.latent_index is None or self.latent_fingerprint != fingerprint:
                        self.latent_index = None
                        self.latent_fingerprint = None
                        index = self.latent_factory(embed=False)
                        for value in values:
                            index.add(value["content"], {"canonical_id": value["id"], "canonical_revision": value["revision"]})
                        index.build()
                        self.latent_index, self.latent_fingerprint = index, fingerprint
                    hits = self.latent_index.retrieve_candidates(query, topN=20)
                except Exception:
                    self.latent_index = None
                    self.latent_fingerprint = None
                    raise ReviewError("latent_unavailable", "Latent 派生检索未成功，未使用旧索引或其他来源。", 503) from None
                pool = {value["id"]: value for value in values}
                selected, seen = [], set()
                for hit in hits:
                    meta = hit.get("meta", {})
                    identifier = meta.get("canonical_id")
                    expected = pool.get(identifier)
                    if not expected or meta.get("canonical_revision") != expected["revision"] or identifier in seen:
                        continue
                    latest = await self.manager.get(identifier)
                    if not latest or revision(latest) != expected["revision"]:
                        self.latent_index = None
                        self.latent_fingerprint = None
                        raise ReviewError("conflict", "正式记忆已变化，旧索引结果已阻止，请重新读取。")
                    selected.append(self._view(snapshot(latest)))
                    seen.add(identifier)
                values = selected
            return {"entries": values, "limitedSearch": bool(query)}

    async def recall(self, ids):
        if not isinstance(ids, list) or len(ids) > 100 or any(not isinstance(item, str) for item in ids):
            raise ReviewError("invalid_request", "召回记录格式无效。", 400)
        ids = list(dict.fromkeys(valid_id(item) for item in ids))
        async with self.writer:
            await self.manager.touch_many(ids, ripple=False)
        return {"touched": len(ids)}

    @staticmethod
    def managed_state(raw):
        meta = raw["metadata"]
        if meta.get("deleted_at"):
            return "deleted"
        log = meta.get("change_log", [])
        marker = next((item for item in reversed(log) if isinstance(item, dict) and item.get("kind") == "float_lifecycle"), None) if isinstance(log, list) else None
        hidden = meta.get("dont_surface")
        hidden = hidden.strip().lower() in ("1", "true", "yes", "on") if isinstance(hidden, str) else bool(hidden)
        return "archived" if meta.get("type") == "archived" or (marker and marker.get("action") == "archive" and hidden) else "active"

    async def _raw(self, target_id):
        # Native get() deliberately hides tombstones. Explicit administrative
        # reads use the pinned native file loader, never audit copies.
        finder, loader = getattr(self.manager, "_find_bucket_file", None), getattr(self.manager, "_load_bucket", None)
        if callable(finder) and callable(loader):
            path = finder(target_id)
            return snapshot(loader(path) if path else None, include_deleted=True)
        for raw in await self.manager.list_all(include_archive=True):
            if raw["id"] == target_id:
                return snapshot(raw, include_deleted=True)
        raise ReviewError("not_found", "记忆不存在或已被永久清除。", 404)

    async def catalog(self, state="active", cursor=""):
        if state not in ("active", "archived", "deleted") or (cursor and not ID.fullmatch(cursor)):
            raise ReviewError("invalid_request", "记忆管理筛选无效。", 400)
        async with self.writer:
            rows = [snapshot(raw, include_deleted=True) for raw in await self.manager.list_all(include_archive=True)
                    if raw.get("metadata", {}).get("type", "dynamic") in ("dynamic", "permanent", "archived")
                    and self.managed_state(raw) == state and (not cursor or raw["id"] > cursor)]
            rows.sort(key=lambda raw: raw["id"])
            page = rows[:100]
            pending = self.db.execute("SELECT * FROM management WHERE state='applying' ORDER BY at LIMIT 100").fetchall()
            return {"entries": [{**raw, "revision": revision(raw, include_deleted=True), "state": state} for raw in page],
                    "nextCursor": page[-1]["id"] if len(rows) > 100 else None,
                    "pending": [{"targetId": row["target_id"], "operation": row["operation"], "clientKey": row["client_key"],
                                 "baseRevision": revision(json.loads(row["before_json"]), include_deleted=True)} for row in pending]}

    @staticmethod
    def _management_result(row):
        return {"id": row["id"], "targetId": row["target_id"], "operation": row["operation"], "state": row["state"]}

    @staticmethod
    def _management_final(row, current):
        expected = json.loads(row["expected_json"])
        operation = row["operation"]
        before = json.loads(row["before_json"])
        if operation == "archive" or (operation == "restore" and not before["metadata"].get("deleted_at")):
            return revision(current, include_deleted=True) == revision(expected, include_deleted=True)
        result = snapshot(current, include_deleted=True)
        if operation == "delete":
            if not result["metadata"].get("deleted_at") or not result["metadata"].get("tombstone"):
                return False
            fields = ("deleted_at", "deleted_reason", "deleted_by", "tombstone", "tombstoned_at", "erasure_mode", "pre_delete_type")
            for key in fields:
                result["metadata"].pop(key, None)
                expected["metadata"].pop(key, None)
        else:
            if result["metadata"].get("deleted_at") or not result["metadata"].get("restored_at"):
                return False
            for key in ("deleted_at", "deleted_reason", "deleted_by", "tombstone", "tombstoned_at", "erasure_mode", "pre_delete_type"):
                expected["metadata"].pop(key, None)
            expected["metadata"]["type"] = before["metadata"].get("pre_delete_type") or before["metadata"].get("type") or "dynamic"
            expected["metadata"].pop("restored_at", None)
            result["metadata"].pop("restored_at", None)
        return revision(result, include_deleted=True) == revision(expected, include_deleted=True)

    async def manage(self, payload):
        if not isinstance(payload, dict) or payload.get("operation") not in ("archive", "delete", "restore"):
            raise ReviewError("invalid_request", "记忆管理操作无效。", 400)
        target = valid_id(payload.get("targetId"))
        key = valid_id(payload.get("clientKey"))
        base = payload.get("baseRevision")
        if not isinstance(base, str) or not REVISION.fullmatch(base):
            raise ReviewError("invalid_revision", "请刷新后再管理这条记忆。", 400)
        operation = payload["operation"]
        fingerprint = hashlib.sha256(packed([target, operation, base]).encode()).hexdigest()
        async with self.writer:
            row = self.db.execute("SELECT * FROM management WHERE client_key=?", (key,)).fetchone()
            if row and row["fingerprint"] != fingerprint:
                raise ReviewError("idempotency_conflict", "同一管理编号已用于其他操作。")
            if row and row["state"] == "completed":
                return self._management_result(row)
            if row and row["state"] == "conflict":
                raise ReviewError("conflict", "此管理操作已有冲突，请刷新后核对。")
            current = await self._raw(target)
            if current["metadata"].get("type", "dynamic") not in ("dynamic", "permanent", "archived"):
                raise ReviewError("unsupported_metadata", "此记录不属于可管理的事实记忆，未修改。")
            if not row:
                if revision(current, include_deleted=True) != base:
                    raise ReviewError("conflict", "记忆已变更，未覆盖新版。")
                state = self.managed_state(current)
                if (operation in ("archive", "delete") and state != "active") or (operation == "restore" and state == "active"):
                    raise ReviewError("conflict", "记忆状态已变更，请刷新。")
                expected = snapshot(current, include_deleted=True)
                log = expected["metadata"].get("change_log", [])
                if not isinstance(log, list):
                    raise ReviewError("unsupported_metadata", "现有修改记录格式不受支持。")
                previous = expected["metadata"].get("dont_surface", False)
                previous = previous.strip().lower() in ("1", "true", "yes", "on") if isinstance(previous, str) else bool(previous)
                identifier = str(uuid4())
                marker = {"kind": "float_lifecycle", "action": operation, "operation_id": identifier, "at": now(), "previousDontSurface": previous, "previousType": expected["metadata"].get("type", "dynamic")}
                expected["metadata"]["change_log"] = log + [marker]
                if operation == "archive":
                    expected["metadata"]["dont_surface"] = True
                    expected["metadata"]["type"] = "archived"
                elif operation == "restore" and not current["metadata"].get("deleted_at"):
                    archive = next((item for item in reversed(log) if isinstance(item, dict) and item.get("kind") == "float_lifecycle"), {})
                    finder, archive_dir = getattr(self.manager, "_find_bucket_file", None), getattr(self.manager, "archive_dir", None)
                    location = finder(target) if finder else None
                    if archive.get("action") != "archive" or archive.get("previousType") not in ("dynamic", "permanent") or (location and archive_dir and Path(location).resolve().is_relative_to(Path(archive_dir).resolve())):
                        raise ReviewError("unsupported_metadata", "原生物理归档没有安全恢复接口；本入口仅恢复自己的归档，未修改。")
                    expected["metadata"]["dont_surface"] = archive.get("previousDontSurface", False) is True
                    expected["metadata"]["type"] = archive["previousType"]
                self.db.execute("INSERT INTO management VALUES(?,?,?,?,?,?,?,?,?,?)", (identifier, key, fingerprint, target, operation, packed(current), packed(expected), None, "applying", now()))
                row = self.db.execute("SELECT * FROM management WHERE id=?", (identifier,)).fetchone()
            if self._management_final(row, current):
                self.db.execute("UPDATE management SET state='completed',after_json=? WHERE id=?", (packed(current), row["id"]))
                return self._management_result(self.db.execute("SELECT * FROM management WHERE id=?", (row["id"],)).fetchone())
            before, expected = json.loads(row["before_json"]), json.loads(row["expected_json"])
            current_revision = revision(current, include_deleted=True)
            if current_revision not in (revision(before, include_deleted=True), revision(expected, include_deleted=True)):
                self.db.execute("UPDATE management SET state='conflict' WHERE id=?", (row["id"],))
                raise ReviewError("conflict", "记忆已变更，未覆盖新版。")
            try:
                if current_revision == revision(before, include_deleted=True):
                    fields = {"change_log": expected["metadata"]["change_log"]}
                    if operation == "archive" or (operation == "restore" and not before["metadata"].get("deleted_at")):
                        fields["dont_surface"] = expected["metadata"]["dont_surface"]
                        fields["type"] = expected["metadata"]["type"]
                    if not await self.manager.update(target, **fields):
                        raise ReviewError("uncertain", "管理操作结果未确认，请恢复核对同一操作。", 503)
                if operation == "delete":
                    written = await self.manager.delete(target, reason="Float user moved memory to recycle bin")
                elif operation == "restore" and before["metadata"].get("deleted_at"):
                    written = await self.manager.restore(target)
                else:
                    written = True
                after = await self._raw(target)
                if not written or not self._management_final(row, after):
                    raise ReviewError("uncertain", "管理操作结果未确认，请恢复核对同一操作。", 503)
                self.db.execute("UPDATE management SET state='completed',after_json=? WHERE id=?", (packed(after), row["id"]))
                return self._management_result(self.db.execute("SELECT * FROM management WHERE id=?", (row["id"],)).fetchone())
            except ReviewError:
                raise
            except Exception:
                raise ReviewError("uncertain", "管理操作结果未确认，已保留记录，请重试同一操作核对。", 503) from None

    def _row(self, candidate_id):
        row = self.db.execute("SELECT * FROM candidates WHERE id=?", (valid_id(candidate_id),)).fetchone()
        if not row:
            raise ReviewError("not_found", "待确认记录不存在。", 404)
        return row

    @staticmethod
    def public(row):
        return {
            "id": row["id"], "kind": row["kind"], "targetId": row["target_id"],
            "content": row["content"], "source": json.loads(row["source"]),
            "before": json.loads(row["before_json"]) if row["before_json"] else None,
            "state": row["state"], "version": row["version"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"],
        }

    def candidates(self):
        rows = self.db.execute("SELECT * FROM candidates WHERE state IN ('pending','applying','conflict') ORDER BY created_at LIMIT 100").fetchall()
        count = self.db.execute("SELECT COUNT(*) FROM candidates WHERE state IN ('pending','applying','conflict')").fetchone()[0]
        return {"candidates": [self.public(row) for row in rows], "total": count}

    async def propose(self, payload, *, manual=False):
        if not isinstance(payload, dict):
            raise ReviewError("invalid_request", "待确认内容格式无效。", 400)
        key = valid_id(payload.get("clientKey"))
        kind = payload.get("kind")
        if kind not in ("create", "edit"):
            raise ReviewError("invalid_request", "仅支持新增或正文修改提案。", 400)
        content = content_text(payload.get("content"))
        source = payload.get("source", {})
        try:
            valid_source = isinstance(source, dict) and len(packed(source).encode()) <= 4096
        except (ValueError, TypeError):
            valid_source = False
        if not valid_source:
            raise ReviewError("invalid_source", "来源信息过长或格式无效。", 400)
        target = valid_id(payload.get("targetId")) if kind == "edit" else ""
        base = payload.get("baseRevision", "") if kind == "edit" else ""
        if kind == "edit" and (not isinstance(base, str) or not REVISION.fullmatch(base)):
            raise ReviewError("invalid_revision", "缺少有效的原版本，请重新读取正文。", 400)
        fingerprint = hashlib.sha256(packed([kind, content, source, target, base]).encode()).hexdigest()
        async with self.writer:
            existing = self.db.execute("SELECT * FROM candidates WHERE client_key=?", (key,)).fetchone()
            if existing:
                if existing["fingerprint"] != fingerprint:
                    raise ReviewError("idempotency_conflict", "同一提交编号已用于不同内容。")
                return self.public(existing)
            if not manual:
                self.check_writable()
            before = None
            if kind == "edit":
                before = snapshot(await self.manager.get(target))
                if revision(before) != base:
                    raise ReviewError("conflict", "正式记忆已在别处更新，请刷新后重新编辑。")
            candidate_id = uuid4().hex
            if kind == "create":
                target = "float_" + candidate_id
            at = now()
            self.db.execute("""INSERT INTO candidates
                (id,client_key,fingerprint,kind,target_id,base_revision,content,source,before_json,expected_json,state,version,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,NULL,'pending',1,?,?)""",
                (candidate_id, key, fingerprint, kind, target, base, content, packed(source), packed(before) if before else None, at, at))
            return self.public(self._row(candidate_id))

    async def revise(self, candidate_id, version, content):
        content = content_text(content)
        async with self.writer:
            self.check_writable()
            row = self._row(candidate_id)
            if row["state"] != "pending" or type(version) is not int or row["version"] != version:
                raise ReviewError("conflict", "待确认内容已变更，请刷新。")
            self.db.execute("UPDATE candidates SET content=?,version=version+1,updated_at=? WHERE id=?", (content, now(), row["id"]))
            return self.public(self._row(row["id"]))

    async def reject(self, candidate_id, version):
        async with self.writer:
            row = self._row(candidate_id)
            if row["state"] == "rejected":
                return self.public(row)
            if row["state"] not in ("pending", "conflict") or type(version) is not int or row["version"] != version:
                raise ReviewError("conflict", "记录状态已变更，不能忽略；请刷新或先恢复未决操作。")
            self.db.execute("UPDATE candidates SET state='rejected',version=version+1,updated_at=? WHERE id=?", (now(), row["id"]))
            return self.public(self._row(row["id"]))

    def _finish(self, row, after):
        before = json.loads(row["before_json"]) if row["before_json"] else None
        after_revision = revision(after)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute("INSERT OR IGNORE INTO history VALUES(?,?,?,?,?,?,?,?)", (
                row["id"], row["target_id"], packed(before) if before else None, packed(after),
                row["base_revision"], after_revision, row["source"], now()))
            self.db.execute("UPDATE candidates SET state='approved',result_revision=?,version=version+1,updated_at=? WHERE id=?", (after_revision, now(), row["id"]))
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        return self.public(self._row(row["id"]))

    def _conflict(self, row):
        self.db.execute("UPDATE candidates SET state='conflict',version=version+1,updated_at=? WHERE id=?", (now(), row["id"]))
        raise ReviewError("conflict", "正式记忆已变更，未覆盖新版。请刷新并重新提出修改。")

    async def approve(self, candidate_id, version, *, manual=False):
        async with self.writer:
            row = self._row(candidate_id)
            if row["state"] == "approved":
                return self.public(row)
            if row["state"] not in ("pending", "applying"):
                raise ReviewError("conflict", "这条记录不能确认，请刷新。")
            if row["state"] == "pending" and (type(version) is not int or row["version"] != version):
                raise ReviewError("conflict", "待确认内容已修改，请重新查看后确认。")
            current = await self.manager.get(row["target_id"])
            if row["state"] == "applying":
                # Intent was persisted before canonical write. A retry never
                # blindly creates another bucket or overwrites an intervening edit.
                if row["kind"] == "create" and current:
                    meta = current.get("metadata", {})
                    if meta.get("grow_batch_id") == row["id"] and current.get("content") == row["content"]:
                        return self._finish(row, snapshot(current))
                    self._conflict(row)
                if row["kind"] == "edit" and current:
                    if revision(current) == revision(json.loads(row["expected_json"])):
                        return self._finish(row, snapshot(current))
                    if revision(current) != row["base_revision"]:
                        self._conflict(row)
            if not manual:
                self.check_writable()
            if row["kind"] == "create":
                if current:
                    self._conflict(row)
                source = json.loads(row["source"])
                finder = getattr(self.manager, "find_exact_content", None)
                original = source.get("entryMetadata") or {}
                from_ai = source.get("origin") == "float_ai" or (isinstance(original, dict) and original.get("origin") == "ai_tool")
                if from_ai and row["state"] == "pending":
                    for raw in await self.manager.list_all(include_archive=True):
                        if raw["content"].strip() == row["content"].strip() and self.managed_state(raw) != "active":
                            raise ReviewError("inactive_memory", "相同记忆已归档或移入回收站，AI 不会自动重新建立。请由用户恢复。")
                match = finder(row["content"]) if row["state"] == "pending" and from_ai and finder else None
                expected_types = ("permanent",) if source.get("memoryType") == "core" else ("dynamic", "permanent")
                if match and match.get("metadata", {}).get("type", "dynamic") in expected_types:
                    self.db.execute("UPDATE candidates SET state='approved',target_id=?,result_revision=?,version=version+1,updated_at=? WHERE id=?", (match["id"], revision(match), now(), row["id"]))
                    return self.public(self._row(row["id"]))
                expected = None
            else:
                if not current or revision(current) != row["base_revision"]:
                    self._conflict(row)
                expected = snapshot(current)
                if expected["content"] == row["content"]:
                    raise ReviewError("no_change", "正文没有变化，无需写入。", 400)
                expected["content"] = row["content"]
                log = expected["metadata"].get("change_log", [])
                if not isinstance(log, list):
                    raise ReviewError("unsupported_metadata", "现有修改记录格式不受支持，未写入。")
                expected["metadata"]["change_log"] = log + [{"kind": "float_review", "operation_id": row["id"], "at": row["created_at"]}]
            self.db.execute("UPDATE candidates SET state='applying',expected_json=?,version=version+1,updated_at=? WHERE id=?", (packed(expected) if expected else None, now(), row["id"]))
            row = self._row(row["id"])
            try:
                if row["kind"] == "create":
                    source = json.loads(row["source"])
                    extra = {"bucket_type": "permanent"} if source.get("memoryType") == "core" else {}
                    importance = source.get("importance")
                    if isinstance(importance, (int, float)) and not isinstance(importance, bool) and 0 <= importance <= 1:
                        extra["importance"] = round(importance * 10)
                    orbis = source.get("entryMetadata", {}).get("orbis") if isinstance(source.get("entryMetadata"), dict) else None
                    if source.get("client") == "orbis_import" and source.get("origin") == "float_user" and isinstance(orbis, dict):
                        extra["tags"] = orbis["tags"]
                        extra["dont_surface"] = orbis["state"] in ("static", "paused")
                        extra["importance"] = 10 if orbis["important"] else 5
                        extra["name"] = "Orbis · " + orbis["id"][:40]
                    created = await self.manager.create(content=row["content"], bucket_id_override=row["target_id"], source_tool="float_review", grow_batch_id=row["id"], **extra)
                    if created != row["target_id"]:
                        self.db.execute("UPDATE candidates SET state='conflict',version=version+1,updated_at=? WHERE id=?", (now(), row["id"]))
                        raise ReviewError("uncertain", "写入返回的 ID 不符合约定，已保留未决记录，禁止盲目重试。")
                else:
                    written = await self.manager.update(row["target_id"], content=row["content"], change_log=expected["metadata"]["change_log"])
                    if not written:
                        raise ReviewError("uncertain", "正文保存结果未确认，已保留未决记录；请恢复核对。")
                after = snapshot(await self.manager.get(row["target_id"]))
                if row["kind"] == "create" and (after["content"] != row["content"] or after["metadata"].get("grow_batch_id") != row["id"]):
                    self._conflict(row)
                if row["kind"] == "edit" and revision(after) != revision(json.loads(row["expected_json"])):
                    self._conflict(row)
                return self._finish(row, after)
            except ReviewError:
                raise
            except Exception:
                raise ReviewError("uncertain", "写入结果未确认，已保留未决记录；请恢复核对，勿重新提交。", 503) from None

    async def record(self, payload, *, manual=False):
        """Default AI path commits automatically; optional review gates only AI.

        An internal durable intent still makes retries recoverable, but it is
        not a request for human approval in automatic mode.
        """
        if not isinstance(payload, dict):
            raise ReviewError("invalid_request", "记忆内容格式无效。", 400)
        source = payload.get("source", {})
        if not isinstance(source, dict):
            raise ReviewError("invalid_source", "来源信息格式无效。", 400)
        payload = {**payload, "source": {**source, "origin": "float_user" if manual else "float_ai"}}
        async with self.writer:
            row = await self.propose(payload, manual=manual)
            if row["state"] == "approved":
                return row
            if row["state"] == "rejected":
                raise ReviewError("rejected", "同一操作之前已被忽略，不会再次写入。")
            if row["state"] == "conflict":
                raise ReviewError("conflict", "此操作已有版本冲突，请重新读取后另行修改。")
            if not manual and self.policy()["reviewRequired"] and row["state"] == "pending":
                return row
            return await self.approve(row["id"], row["version"], manual=manual)

    async def undo(self, operation_id, client_key):
        async with self.writer:
            row = await self.propose_undo(operation_id, client_key, manual=True)
            return await self.approve(row["id"], row["version"], manual=True)

    def history(self, target_id):
        rows = self.db.execute("SELECT * FROM history WHERE bucket_id=? ORDER BY rowid DESC LIMIT 30", (valid_id(target_id),)).fetchall()
        return {"history": [{"id": row["id"], "targetId": row["bucket_id"], "before": json.loads(row["before_json"]) if row["before_json"] else None,
            "after": json.loads(row["after_json"]), "afterRevision": row["after_revision"], "source": json.loads(row["source"]), "at": row["at"]} for row in rows]}

    async def propose_undo(self, operation_id, client_key, *, manual=False):
        async with self.writer:
            operation_id = valid_id(operation_id)
            client_key = valid_id(client_key)
            existing = self.db.execute("SELECT * FROM candidates WHERE client_key=?", (client_key,)).fetchone()
            if existing:
                source = json.loads(existing["source"])
                if source.get("origin") != "float_undo" or source.get("operationId") != operation_id:
                    raise ReviewError("idempotency_conflict", "同一提交编号已用于不同内容。")
                return self.public(existing)
            row = self.db.execute("SELECT * FROM history WHERE id=?", (valid_id(operation_id),)).fetchone()
            if not row or not row["before_json"]:
                raise ReviewError("unsupported_undo", "仅支持撤销已有记忆的正文修改；新增记忆不能由此删除。")
            current = await self.manager.get(row["bucket_id"])
            if not current or revision(current) != row["after_revision"]:
                raise ReviewError("conflict", "此后已有其他修改，撤销不会覆盖新版。请手动核对。")
            return await self.propose({"clientKey": client_key, "kind": "edit", "targetId": row["bucket_id"],
                "baseRevision": row["after_revision"], "content": json.loads(row["before_json"])["content"],
                "source": {"origin": "float_undo", "operationId": row["id"]}}, manual=manual)


def register(mcp, manager, config):
    """Called only from a version-checked, explicitly installed Ombre overlay."""
    token = os.environ.get("FLOAT_REVIEW_SERVICE_TOKEN", "").strip()
    if len(token) < 32 or len(token) > 512:
        raise RuntimeError("FLOAT_REVIEW_SERVICE_TOKEN must contain at least 32 characters")
    from starlette.responses import JSONResponse
    from web.search import _SURFACE_POLICY
    from float_provider_state import install_runtime
    install_runtime(config["buckets_dir"])
    service = ReviewService(manager, config["buckets_dir"], surface_policy=_SURFACE_POLICY)
    headers = {"Cache-Control": "private, no-store"}

    @mcp.custom_route("/float-memory/v2/{action}", methods=["GET", "POST"])
    async def review_route(request):
        supplied = request.headers.get("authorization", "")
        if len(supplied) > 1024 or not hmac.compare_digest(supplied.encode(), ("Bearer " + token).encode()):
            return JSONResponse({"ok": False, "code": "unauthorized", "error": "Unauthorized"}, status_code=401, headers=headers)
        action = request.path_params["action"]
        try:
            if request.method == "GET":
                if action == "status":
                    result = {"protocol": PROTOCOL, "policy": service.policy(), "nativeWritesReviewed": False, "latent": service.latent_factory is not None, "latentMode": service.latent_mode if service.latent_factory else None, "latentIndexState": service.latent_semantic.state if service.latent_semantic else None, "management": True, "orbisImport": True, "consolidation": "float-consolidation/v1"}
                elif action == "candidates": result = service.candidates()
                elif action == "detail": result = {"entry": await service.detail(request.query_params.get("id", ""))}
                elif action == "history": result = service.history(request.query_params.get("id", ""))
                elif action == "memories": result = await service.memories(request.query_params.get("q"), request.query_params.get("engine", "ombre"))
                elif action == "catalog": result = await service.catalog(request.query_params.get("state", "active"), request.query_params.get("cursor", ""))
                elif action == "import_batches": result = service.orbis.batches()
                else: raise ReviewError("invalid_action", "Unsupported read action", 400)
            else:
                raw = bytearray()
                async for chunk in request.stream():
                    raw.extend(chunk)
                    if len(raw) > (256 * 1024 if action == "consolidation" else 128 * 1024 if action in ("workspaces", "private_spaces") else 64 * 1024):
                        raise ReviewError("too_large", "Request too large", 413)
                try: body = json.loads(raw)
                except (ValueError, UnicodeDecodeError): raise ReviewError("invalid_request", "Invalid JSON", 400) from None
                if not isinstance(body, dict): raise ReviewError("invalid_request", "JSON object required", 400)
                if action == "private_spaces": result = await service.private_spaces.dispatch(body)
                elif action == "workspaces": result = await service.workspaces.dispatch(body)
                elif action == "consolidation": result = await service.consolidation.dispatch(body)
                elif action == "record": result = {"candidate": await service.record(body)}
                elif action == "save": result = {"candidate": await service.record(body, manual=True)}
                elif action == "propose": result = {"candidate": await service.propose(body)}
                elif action == "revise": result = {"candidate": await service.revise(body.get("id"), body.get("version"), body.get("content"))}
                elif action == "approve": result = {"candidate": await service.approve(body.get("id"), body.get("version"), manual=True)}
                elif action == "reject": result = {"candidate": await service.reject(body.get("id"), body.get("version"))}
                elif action == "undo": result = {"candidate": await service.propose_undo(body.get("id"), body.get("clientKey"))}
                elif action == "undo_save": result = {"candidate": await service.undo(body.get("id"), body.get("clientKey"))}
                elif action == "policy": result = {"policy": await service.set_policy(body.get("paused"), body.get("version"), body.get("reviewRequired"))}
                elif action == "recall": result = await service.recall(body.get("ids"))
                elif action == "manage": result = {"management": await service.manage(body)}
                elif action == "import_note": result = {"importReceipt": await service.orbis.import_note(body)}
                elif action == "import_rollback": result = await service.orbis.rollback(body.get("batchId"), body.get("cursor"))
                else: raise ReviewError("invalid_action", "Unsupported write action", 400)
            return JSONResponse({"ok": True, **result}, headers=headers)
        except ReviewError as error:
            return JSONResponse({"ok": False, "code": error.code, "error": str(error)}, status_code=error.status, headers=headers)
        except Exception:
            return JSONResponse({"ok": False, "code": "internal", "error": "Review operation failed"}, status_code=500, headers=headers)

    return service
