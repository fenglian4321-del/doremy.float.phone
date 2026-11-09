"""Memory-only import of the verified Orbis orbis_memory_export_v1 note DTO.

No backup/chat parser. Original body lives in the canonical bucket; immutable
import receipts preserve source metadata and support guarded batch rollback.
"""
import hashlib
import re
from datetime import datetime, timezone

FIELDS = {"id", "assistantId", "body", "summary", "state", "previousState", "tags", "keywords", "important", "minIntervalTurns", "createdAt", "updatedAt", "revision", "deleted"}
STATES = {"static", "conditional", "pinned", "paused"}


class OrbisImporter:
    def __init__(self, service, error, revision, packed):
        self.service, self.error, self.revision, self.packed = service, error, revision, packed
        service.db.execute("""CREATE TABLE IF NOT EXISTS orbis_imports (
            identity TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, batch_id TEXT NOT NULL,
            note_json TEXT NOT NULL, client_key TEXT NOT NULL, target_id TEXT,
            after_revision TEXT, owned INTEGER NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL
        )""")

    def normalize(self, note):
        def refuse(message):
            raise self.error("invalid_import", message, 400)
        if not isinstance(note, dict) or set(note) - FIELDS:
            refuse("仅接受 Orbis 记忆条目，不能导入聊天或未知字段。")
        for key in ("id", "assistantId"):
            if not isinstance(note.get(key), str) or not 1 <= len(note[key]) <= 160 or re.search(r"[\x00-\x1f]", note[key]):
                refuse("Orbis 来源标识无效。")
        body = note.get("body")
        try:
            length = len(body.encode("utf-16-le")) // 2 if isinstance(body, str) else 0
        except UnicodeEncodeError:
            refuse("正文包含无效 Unicode，未修改。")
        if not isinstance(body, str) or not body.strip() or length > 12000 or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]", body):
            refuse("正文超过当前 12000 字符容量或含危险控制字符；没有截断或导入。")
        capacity = getattr(self.service.manager, "_max_bucket_bytes", None)
        if callable(capacity) and capacity() > 0 and len(body.encode()) > capacity():
            refuse("正文超过此 Ombre 实例的字节容量，未写入。")
        normalized = {"summary": "", "state": "static", "previousState": "static", "tags": [], "keywords": [], "important": False, "minIntervalTurns": 0, "revision": 1, "deleted": False, **note}
        if normalized["state"] not in STATES or normalized["previousState"] not in STATES - {"paused"} or not isinstance(normalized["summary"], str):
            refuse("Orbis 状态或摘要无效。")
        for key in ("createdAt", "updatedAt", "revision", "minIntervalTurns"):
            if type(normalized.get(key)) is not int or not 0 <= normalized[key] <= 8_640_000_000_000_000:
                refuse("Orbis 时间、版本或间隔无效。")
        if normalized["revision"] < 1 or type(normalized["important"]) is not bool or type(normalized["deleted"]) is not bool or normalized["deleted"]:
            refuse("已删除或版本无效的 Orbis 条目不会导入。")
        for key in ("tags", "keywords"):
            value = normalized[key]
            if not isinstance(value, list) or len(value) > 32 or any(not isinstance(item, str) or len(item) > 80 or re.search(r"[\x00-\x1f]", item) for item in value):
                refuse("Orbis 标签或关键词超出当前容量，未截断导入。")
        source = {key: value for key, value in normalized.items() if key != "body"}
        if len(self.packed(source).encode()) > 3000:
            refuse("来源元数据超过当前容量，未截断导入。")
        return normalized

    def receipt(self, row, state=None):
        return {"targetId": row["target_id"], "batchId": row["batch_id"], "state": state or row["state"], "owned": bool(row["owned"])}

    async def import_note(self, payload):
        if not isinstance(payload, dict) or not isinstance(payload.get("batchId"), str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,160}", payload["batchId"]):
            raise self.error("invalid_import", "导入批次无效。", 400)
        note = self.normalize(payload.get("note"))
        canonical_body = note["body"].strip()
        identity = hashlib.sha256(self.packed([note["assistantId"], note["id"]]).encode()).hexdigest()
        fingerprint = hashlib.sha256(self.packed(note).encode()).hexdigest()
        service = self.service
        async with service.writer:
            row = service.db.execute("SELECT * FROM orbis_imports WHERE identity=?", (identity,)).fetchone()
            if row:
                if row["payload_hash"] != fingerprint:
                    raise self.error("import_conflict", "此 Orbis 条目已导入过不同版本，未覆盖现有记忆；请在记忆库人工核对。")
                if row["state"] == "rolled_back":
                    raise self.error("import_conflict", "此条导入已撤销，不会因重复导入自动复活。")
                if row["state"] == "completed":
                    return self.receipt(row, "existing")
            else:
                if service.db.execute("SELECT COUNT(*) FROM orbis_imports WHERE batch_id=?", (payload["batchId"],)).fetchone()[0] >= 1000:
                    raise self.error("invalid_import", "每批最多 1000 条，请另开批次。", 400)
                # Preserve a durable import identity before calling the existing
                # durable canonical write path. Retry resumes the same intent.
                at = datetime.now(timezone.utc).isoformat()
                key = "orbis_" + hashlib.sha256((identity + fingerprint).encode()).hexdigest()
                service.db.execute("INSERT INTO orbis_imports VALUES(?,?,?,?,?,?,?,?,?,?)", (identity, fingerprint, payload["batchId"], self.packed(note), key, None, None, 1, "applying", at))
                row = service.db.execute("SELECT * FROM orbis_imports WHERE identity=?", (identity,)).fetchone()
                existing = service.manager.find_exact_content(canonical_body)
                if existing and service.managed_state(existing) == "active":
                    service.db.execute("UPDATE orbis_imports SET target_id=?,after_revision=?,owned=0,state='completed' WHERE identity=?", (existing["id"], self.revision(existing), identity))
                    return self.receipt(service.db.execute("SELECT * FROM orbis_imports WHERE identity=?", (identity,)).fetchone(), "existing")
            metadata = {key: value for key, value in note.items() if key != "body"}
            source = {"client": "orbis_import", "importBatchId": row["batch_id"], "memoryType": "core" if note["state"] == "pinned" else "long_term", "entryMetadata": {"orbis": metadata, "originalBodySha256": hashlib.sha256(note["body"].encode()).hexdigest()}}
            result = await service.record({"clientKey": row["client_key"], "kind": "create", "content": canonical_body, "source": source}, manual=True)
            operation = service._row(result["id"])
            if result["state"] != "approved" or not operation["result_revision"]:
                raise self.error("uncertain", "导入结果未确认，请重试同一条目恢复核对。", 503)
            service.db.execute("UPDATE orbis_imports SET target_id=?,after_revision=?,state='completed' WHERE identity=?", (result["targetId"], operation["result_revision"], identity))
            return self.receipt(service.db.execute("SELECT * FROM orbis_imports WHERE identity=?", (identity,)).fetchone(), "created")

    def batches(self):
        rows = self.service.db.execute("SELECT batch_id,MIN(at) AS at,COUNT(*) AS total,SUM(owned=1 AND target_id IS NOT NULL) AS created,SUM(state='rolled_back') AS undone,SUM(state='applying') AS pending FROM orbis_imports GROUP BY batch_id ORDER BY at DESC LIMIT 30").fetchall()
        return {"batches": [{"id": row["batch_id"], "at": row["at"], "total": row["total"], "created": row["created"], "undone": row["undone"], "pending": row["pending"]} for row in rows]}

    async def rollback(self, batch_id, cursor=None):
        if not isinstance(batch_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,160}", batch_id) or (cursor is not None and (not isinstance(cursor, str) or not re.fullmatch(r"[0-9a-f]{64}", cursor))):
            raise self.error("invalid_import", "导入批次无效。", 400)
        service = self.service
        results = []
        async with service.writer:
            rows = service.db.execute("SELECT * FROM orbis_imports WHERE batch_id=? AND identity>? ORDER BY identity LIMIT 21", (batch_id, cursor or "")).fetchall()
            if not rows:
                raise self.error("not_found", "导入批次不存在。", 404)
            more = len(rows) > 20
            rows = rows[:20]
            for row in rows:
                if not row["owned"] or row["state"] != "completed":
                    results.append({"targetId": row["target_id"], "state": "kept_existing" if not row["owned"] else row["state"]}); continue
                try:
                    await service.manage({"operation": "delete", "targetId": row["target_id"], "baseRevision": row["after_revision"], "clientKey": "orbis_undo_" + hashlib.sha256((batch_id + row["identity"]).encode()).hexdigest()})
                    service.db.execute("UPDATE orbis_imports SET state='rolled_back' WHERE identity=?", (row["identity"],))
                    results.append({"targetId": row["target_id"], "state": "rolled_back"})
                except self.error as error:
                    results.append({"targetId": row["target_id"], "state": "needs_review", "code": error.code})
        return {"results": results, "nextCursor": rows[-1]["identity"] if more else None}
