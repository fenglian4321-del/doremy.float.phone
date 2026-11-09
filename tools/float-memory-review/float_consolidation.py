"""Shared consolidation control plane. Stores watermarks, not a second chat log.

One writer/process, the same review SQLite and canonical BucketManager. The
current chat model supplies a decision; this module never calls any model.
"""
from __future__ import annotations

import hashlib
import copy
import hmac
import json
import re
import time
from uuid import uuid4

PROTOCOL = "float-consolidation/v1"
DEFAULTS = dict(automatic=True, manual=True, unit="user_turns", count=20,
                tokenThreshold=0, compression=True, recentGroups=16,
                recentTokens=6000, summaryChars=4000, taskTokens=10000)
HEX = re.compile(r"[0-9a-f]{64}\Z")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]")


def js(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(js(value).encode()).hexdigest()


class Consolidation:
    def __init__(self, service, error, revision):
        self.s, self.error, self.revision = service, error, revision
        service.db.executescript("""
          CREATE TABLE IF NOT EXISTS consolidation_scopes(id TEXT PRIMARY KEY, state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS consolidation_jobs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, state TEXT NOT NULL);
        """)

    def fail(self, code, text, status=409):
        raise self.error(code, text, status)

    def text(self, value, maximum):
        return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum and not CONTROL.search(value)

    def config(self, value):
        if not isinstance(value, dict) or set(value) != set(DEFAULTS):
            self.fail("invalid_config", "整理设置格式无效。", 400)
        for key in ("automatic", "manual", "compression"):
            if type(value[key]) is not bool:
                self.fail("invalid_config", "整理开关无效。", 400)
        if value["unit"] not in ("user_turns", "message_groups"):
            self.fail("invalid_config", "计数单位无效。", 400)
        for key, low, high in (("count", 1, 10000), ("tokenThreshold", 0, 2000000),
                               ("recentGroups", 1, 200), ("recentTokens", 256, 100000),
                               ("summaryChars", 200, 12000), ("taskTokens", 512, 50000)):
            if type(value[key]) is not int or not low <= value[key] <= high:
                self.fail("invalid_config", "整理预算或阈值超出范围。", 400)
        return dict(value)

    def load(self, scope):
        if not isinstance(scope, dict) or set(scope) != {"kind", "sessionId", "actorId"} or scope["kind"] not in ("chat", "group_chat") or any(not self.text(scope[k], 160) for k in ("sessionId", "actorId")):
            self.fail("invalid_scope", "请选择具体对话与角色。", 400)
        key = digest([scope["kind"], scope["sessionId"], scope["actorId"]])
        row = self.s.db.execute("SELECT state FROM consolidation_scopes WHERE id=?", (key,)).fetchone()
        state = json.loads(row[0]) if row else dict(scope=scope, config=dict(DEFAULTS), version=1, records={}, seq=0, summary=[], summaryVersion=0, manual=0, lastSuccess=None, active=None)
        return key, state

    def save(self, key, state):
        self.s.db.execute("INSERT INTO consolidation_scopes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state", (key, js(state)))

    def job(self, key):
        row = self.s.db.execute("SELECT state FROM consolidation_jobs WHERE id=?", (key,)).fetchone()
        if not row:
            self.fail("job_missing", "整理任务不存在。", 404)
        return json.loads(row[0])

    def save_job(self, job):
        self.s.db.execute("INSERT INTO consolidation_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state", (job["id"], job["scope"], js(job)))

    def live_summary(self, state):
        records = state["records"]
        return [segment for segment in state["summary"] if all(ref["id"] in records and not records[ref["id"]]["retired"] and records[ref["id"]]["digest"] == ref["digest"] for ref in segment["sources"])]

    def pending(self, state):
        return sorted(((key, row) for key, row in state["records"].items() if not row["retired"] and row["processed"] != row["digest"]), key=lambda item: item[1]["seq"])

    def view(self, state):
        pending = self.pending(state)
        fresh = [row for _, row in pending if not row["ever"]]
        count = sum(row["role"] == "user" for row in fresh) if state["config"]["unit"] == "user_turns" else len(fresh)
        tokens = sum(row["tokens"] for row in fresh)
        config = state["config"]
        latched = any(row["seq"] <= state.get("pendingThrough", 0) for _, row in pending)
        due = bool(pending) and (bool(state["manual"]) or (config["automatic"] and (latched or count >= config["count"] or (config["tokenThreshold"] > 0 and tokens >= config["tokenThreshold"]))))
        active = self.job(state["active"]) if state["active"] else None
        return dict(protocol=PROTOCOL, config=config, version=state["version"], count=count, tokens=tokens, tokenKind="estimate", pending=len(pending), dirty=sum(row["ever"] for _, row in pending), due=due, queued=bool(state["manual"]), lastSuccess=state["lastSuccess"], summary=[dict(text=s["text"], sources=s["sources"]) for s in self.live_summary(state)], active={k: active.get(k) for k in ("id", "state", "error", "expires", "receipts")} if active else None)

    def claim(self, job, body, *, allow_expired=False):
        claim = body.get("claim")
        if not self.text(claim, 160) or not hmac.compare_digest(job["claim"], digest(claim)):
            self.fail("claim_conflict", "整理任务正在另一请求或设备上进行。")
        if not allow_expired and job["state"] == "prepared" and job["expires"] < time.time():
            self.fail("lease_expired", "整理任务租约已过期；进度仍保留，请下一轮重试。")

    async def fence(self):
        return {row["id"]: self.revision(row, include_deleted=True) for row in await self.s.manager.list_all(include_archive=True)}

    async def check_fence(self, job):
        current = await self.fence()
        # Only the exact writes made by this job may differ from the starting
        # fence. Human edits (including edits to our partially saved facts) win.
        expected = dict(job["fence"])
        for row in self.s.db.execute("SELECT target_id,state,result_revision FROM candidates WHERE client_key LIKE ?", ("con_" + job["id"] + "_%",)):
            if row["state"] == "approved":
                expected[row["target_id"]] = row["result_revision"]
            elif row["state"] == "applying":
                target = await self.s.manager.get(row["target_id"])
                candidate = self.s.db.execute("SELECT * FROM candidates WHERE target_id=? AND client_key LIKE ?", (row["target_id"], "con_" + job["id"] + "_%")).fetchone()
                if target and target["content"] == candidate["content"] and target["metadata"].get("grow_batch_id") == candidate["id"]:
                    expected[row["target_id"]] = self.revision(target)
        if current != expected:
            self.fail("memory_changed", "正式记忆已有其他修改；保留人工版本与待整理进度，请核对后重新整理。")

    async def dispatch(self, body):
        async with self.s.writer:
            if not isinstance(body, dict):
                self.fail("invalid_request", "整理请求格式无效。", 400)
            key, state = self.load(body.get("scope"))
            op = body.get("operation")
            if op == "status":
                return self.view(state)
            if op == "configure":
                if body.get("version") != state["version"]:
                    self.fail("version_conflict", "另一设备修改过设置，请刷新。")
                state["config"] = self.config(body.get("config"))
                state["version"] += 1
                self.save(key, state)
                return self.view(state)
            if op == "observe":
                changes, removed = body.get("records", []), body.get("removed", [])
                if not isinstance(changes, list) or not isinstance(removed, list) or len(changes) + len(removed) > 100:
                    self.fail("invalid_records", "一次最多同步100个消息组的计数元数据。", 400)
                conflicts = []
                for item in changes:
                    if not isinstance(item, dict) or not HEX.fullmatch(str(item.get("id", ""))) or not HEX.fullmatch(str(item.get("digest", ""))) or item.get("role") not in ("user", "assistant") or not self.text(item.get("actor"), 160) or type(item.get("tokens")) is not int or not 0 <= item["tokens"] <= 2000000:
                        self.fail("invalid_records", "消息组计数元数据无效。", 400)
                    old = state["records"].get(item["id"])
                    if old and old["digest"] == item["digest"] and not old["retired"]:
                        continue
                    if old and item.get("baseVersion") != old["version"]:
                        conflicts.append(item["id"])
                        continue
                    if not old:
                        if len(state["records"]) >= 20000:
                            self.fail("scope_capacity", "此对话的共享进度已达容量，未遗忘或截断历史。")
                        state["seq"] += 1
                    state["records"][item["id"]] = dict(digest=item["digest"], role=item["role"], actor=item["actor"], tokens=item["tokens"], version=old["version"] + 1 if old else 1, seq=old["seq"] if old else state["seq"], ever=old["ever"] if old else False, processed=old["processed"] if old else None, retired=False)
                for item in removed:
                    if not isinstance(item, dict) or not HEX.fullmatch(str(item.get("id", ""))):
                        self.fail("invalid_records", "移除消息组标识无效。", 400)
                    old = state["records"].get(item["id"])
                    if old and not old["retired"]:
                        if item.get("baseVersion") != old["version"]:
                            conflicts.append(item["id"])
                        else:
                            old["retired"], old["version"] = True, old["version"] + 1
                self.save(key, state)
                ids = {item["id"] for item in changes + removed}
                return {**self.view(state), "conflicts": conflicts, "versions": {i: dict(version=state["records"][i]["version"], digest=state["records"][i]["digest"], retired=state["records"][i]["retired"]) for i in ids if i in state["records"]}}
            if op == "queue":
                if not state["config"]["manual"]:
                    self.fail("manual_disabled", "本对话未开启手动整理。")
                state["manual"] += 1
                self.save(key, state)
                return self.view(state)
            if op == "prepare":
                self.s.check_writable()
                claim = body.get("claim")
                if not self.text(claim, 160):
                    self.fail("invalid_claim", "整理请求标识无效。", 400)
                if state["active"]:
                    old = self.job(state["active"])
                    if old["state"] != "prepared" or old["expires"] > time.time():
                        self.claim(old, body)
                        return {**self.view(state), "job": self.public_job(old)}
                    old["state"] = "expired"
                    self.save_job(old)
                    state["active"] = None
                if body.get("immediate"):
                    if not state["config"]["manual"]:
                        self.fail("manual_disabled", "手动整理未开启。")
                    if not self.pending(state):
                        return {**self.view(state), "job": None}
                    state["manual"] += 1
                if not self.view(state)["due"]:
                    self.save(key, state)
                    return {**self.view(state), "job": None}
                # A budget-limited prefix must not make the rest of an already
                # triggered batch fall below the threshold and become stranded.
                if not any(row["seq"] <= state.get("pendingThrough", 0) for _, row in self.pending(state)):
                    state["pendingThrough"] = max(row["seq"] for _, row in self.pending(state))
                available = body.get("available")
                budget = body.get("budget")
                if not isinstance(available, list) or len(available) > 20000 or type(budget) is not int or not 0 < budget <= state["config"]["taskTokens"]:
                    self.fail("invalid_budget", "整理输入预算无效。", 400)
                selected, used = [], 0
                for i, row in self.pending(state):
                    if i not in available:
                        self.fail("messages_unavailable", "较早的待整理消息不在此设备；请先同步原对话，不会跳过它们。")
                    if len(selected) >= 100 or used + row["tokens"] > budget:
                        break
                    selected.append(dict(id=i, digest=row["digest"], version=row["version"]))
                    used += row["tokens"]
                if not selected:
                    self.fail("input_over_budget", "最早的消息组超过整理预算；未截断原文，请调整预算。")
                job = dict(id=uuid4().hex, scope=key, claim=digest(claim), expires=time.time() + 90, state="prepared", inputs=selected, inputDigest=digest([[r["id"], r["version"], r["digest"]] for r in selected]), previous=[dict(ref=f"s{i+1}", **segment) for i, segment in enumerate(self.live_summary(state))], compression=state["config"]["compression"], summaryChars=state["config"]["summaryChars"], configVersion=state["version"], summaryVersion=state["summaryVersion"], manual=state["manual"], fence=await self.fence(), receipts=[], decision=None, error=None)
                state["active"] = job["id"]
                self.save_job(job)
                self.save(key, state)
                return {**self.view(state), "job": self.public_job(job)}
            job = self.job(body.get("jobId")) if isinstance(body.get("jobId"), str) else None
            if not job or job["scope"] != key:
                self.fail("job_missing", "本对话不存在此任务。", 404)
            if op == "resume" and job["state"] == "complete":
                return {**self.view(state), "receipt": job["id"]}
            if state["active"] != job["id"]:
                self.fail("job_inactive", "此任务已结束或由新任务取代。")
            if op == "adopt":
                if job["state"] == "prepared" and job["expires"] > time.time():
                    self.fail("job_busy", "另一设备还在生成，请等待它完成或租约到期。")
                if not self.text(body.get("claim"), 160):
                    self.fail("invalid_claim", "恢复标识无效。", 400)
                job["claim"], job["expires"] = digest(body["claim"]), time.time() + 90
                self.save_job(job)
                return {**self.view(state), "job": self.public_job(job)}
            self.claim(job, body, allow_expired=op == "abandon")
            if op == "heartbeat":
                job["expires"] = time.time() + 90
                self.save_job(job)
                return {"protocol": PROTOCOL}
            if op == "abandon":
                # Does not erase or undo any partially written canonical fact.
                job["state"] = "abandoned"
                state["active"] = None
                self.save_job(job)
                self.save(key, state)
                return self.view(state)
            if op == "stage":
                if job["decision"] is not None:
                    if digest(body.get("decision")) != digest(job["decision"]):
                        self.fail("decision_conflict", "同一任务不能换另一份整理结果。")
                else:
                    self.check_inputs(state, job)
                    await self.check_fence(job)
                    self.validate(job, state, body.get("records"), body.get("decision"))
                    job["decision"] = body["decision"]
                    job["state"] = "staged"
                    self.save_job(job)  # Durable BEFORE any Markdown writes.
            elif op != "resume":
                self.fail("invalid_operation", "不支持的整理操作。", 400)
            if job["decision"] is None:
                self.fail("decision_missing", "尚未收到有效决策；未调用模型重试或清零。")
            try:
                return await self.commit(key, state, job)
            except Exception as exc:
                job["error"] = exc.code if isinstance(exc, self.error) else "commit_failed"
                self.save_job(job)
                raise

    def check_inputs(self, state, job):
        if state["version"] != job["configVersion"] or state["summaryVersion"] != job["summaryVersion"]:
            self.fail("config_changed", "整理期间设置或摘要已改变，未覆盖新版本。")
        for item in job["inputs"]:
            current = state["records"].get(item["id"])
            if not current or current["retired"] or current["version"] != item["version"] or current["digest"] != item["digest"]:
                self.fail("source_changed", "整理期间原消息已编辑、重生成或移除，未保存过时结论。")

    def public_job(self, job):
        return {k: job[k] for k in ("id", "inputDigest", "inputs", "previous", "compression", "summaryChars", "state")}

    def validate(self, job, state, records, decision):
        if not isinstance(records, list) or len(records) != len(job["inputs"]):
            self.fail("invalid_proof", "原文证据不完整。", 400)
        for item, row in zip(job["inputs"], records):
            if not isinstance(row, dict) or row.get("id") != item["id"] or not isinstance(row.get("parts"), list) or not 1 <= len(row["parts"]) <= 200:
                self.fail("invalid_proof", "原文证据格式无效。", 400)
            if any(not isinstance(p, dict) or not self.text(p.get("id"), 240) or not self.text(p.get("text"), 128000) or not self.text(p.get("at"), 80) for p in row["parts"]):
                self.fail("invalid_proof", "原文证据字段无效。", 400)
            meta = state["records"][item["id"]]
            if row.get("role") != meta["role"] or row.get("actor") != meta["actor"] or digest([row["role"], row["actor"], [[p["id"], p["text"], p["at"]] for p in row["parts"]]]) != item["digest"]:
                self.fail("source_changed", "原文与共享进度版本不一致。")
        keys = {"protocol", "jobId", "inputDigest", "decision", "reason", "summary", "facts"}
        if not isinstance(decision, dict) or set(decision) != keys or decision["protocol"] != PROTOCOL or decision["jobId"] != job["id"] or decision["inputDigest"] != job["inputDigest"] or decision["decision"] not in ("remember", "none") or not self.text(decision["reason"], 500) or not isinstance(decision["facts"], list) or len(decision["facts"]) > 5 or (bool(decision["facts"]) != (decision["decision"] == "remember")):
            self.fail("invalid_decision", "整理决策结构或任务标识无效。", 400)
        seen = set()
        proof = []
        for fact in decision["facts"]:
            if not isinstance(fact, dict) or set(fact) != {"content", "kind", "evidence"} or not self.text(fact["content"], 1000) or fact["content"].strip() in seen or fact["kind"] not in ("user_fact", "assistant_commitment") or not isinstance(fact["evidence"], list) or not 1 <= len(fact["evidence"]) <= 3:
                self.fail("invalid_fact", "长期事实或证据格式无效。", 400)
            seen.add(fact["content"].strip())
            fact_proof = []
            for evidence in fact["evidence"]:
                if not isinstance(evidence, dict) or set(evidence) != {"ref", "quote"} or not re.fullmatch(r"r[1-9]\d*", str(evidence["ref"])) or not self.text(evidence["quote"], 240):
                    self.fail("invalid_evidence", "证据引用格式无效。", 400)
                i = int(evidence["ref"][1:]) - 1
                if i >= len(records):
                    self.fail("invalid_evidence", "证据引用不存在。", 400)
                source = records[i]
                if not any(evidence["quote"] in p["text"] for p in source["parts"]) or (source["role"] != "user" if fact["kind"] == "user_fact" else source["role"] != "assistant" or source["actor"] == "unknown"):
                    self.fail("invalid_evidence", "证据不是原话或说话人不匹配。", 400)
                part = next(p for p in source["parts"] if evidence["quote"] in p["text"])
                fact_proof.append(dict(ref=evidence["ref"], quote=evidence["quote"], messageId=part["id"], at=part["at"], actor=source["actor"], **job["inputs"][i]))
            proof.append(fact_proof)
        job["evidence"] = proof
        summary = decision["summary"]
        if not job["compression"]:
            if summary is not None:
                self.fail("invalid_summary", "此任务未启用压缩摘要。", 400)
            return
        if not isinstance(summary, list) or len(summary) > 16 or (job["previous"] and not summary):
            self.fail("invalid_summary", "压缩摘要格式无效或意外清空旧摘要。", 400)
        chars = 0
        valid = {f"r{i+1}" for i in range(len(records))} | {s["ref"] for s in job["previous"]}
        for segment in summary:
            if not isinstance(segment, dict) or set(segment) != {"text", "refs"} or not self.text(segment["text"], job["summaryChars"]) or not isinstance(segment["refs"], list) or not 1 <= len(segment["refs"]) <= 116 or any(not isinstance(r, str) or r not in valid for r in segment["refs"]):
                self.fail("invalid_summary", "压缩摘要缺少有效来源。", 400)
            chars += len(segment["text"])
        if chars > job["summaryChars"]:
            self.fail("invalid_summary", "压缩摘要超过容量。", 400)

    async def commit(self, key, state, job):
        self.s.check_writable()
        self.check_inputs(state, job)
        await self.check_fence(job)
        for i, fact in enumerate(job["decision"]["facts"]):
            sources = job["evidence"][i]
            result = await self.s.record(dict(clientKey=f"con_{job['id']}_{i}", kind="create", content=fact["content"], source=dict(client="float_consolidation", sessionId=state["scope"]["sessionId"], characterId=state["scope"]["actorId"], memoryType="long_term", consolidation=dict(jobId=job["id"], kind=fact["kind"], evidence=sources))))
            if result["id"] not in job["receipts"]:
                job["receipts"].append(result["id"])
            self.save_job(job)
            if result["state"] != "approved":
                job["state"] = "waiting_review"
                self.save_job(job)
                return self.view(state)
        segments = []
        for segment in job["decision"]["summary"] or []:
            refs = {}
            for ref in segment["refs"]:
                sources = [job["inputs"][int(ref[1:])-1]] if ref.startswith("r") else next(s["sources"] for s in job["previous"] if s["ref"] == ref)
                for source in sources:
                    refs[source["id"]] = dict(id=source["id"], digest=source["digest"])
            if len(refs) > 4096:
                self.fail("lineage_capacity", "摘要来源已达容量；待处理进度仍保留。")
            segments.append(dict(text=segment["text"], sources=list(refs.values())))
        # The in-memory job held by dispatch must remain staged if the final
        # SQLite transaction fails, so its recovery receipt cannot say complete.
        state, job = copy.deepcopy(state), copy.deepcopy(job)
        for item in job["inputs"]:
            state["records"][item["id"]].update(processed=item["digest"], ever=True)
        if job["compression"]:
            state["summary"] = segments
            state["summaryVersion"] += 1
        if not any(row["seq"] <= state.get("pendingThrough", 0) for _, row in self.pending(state)):
            state["pendingThrough"] = 0
            if state["manual"] == job["manual"]:
                state["manual"] = 0
        state["lastSuccess"] = dict(jobId=job["id"], at=time.time(), facts=len(job["decision"]["facts"]), decision=job["decision"]["decision"])
        state["active"] = None
        job["state"], job["error"], job["fence"] = "complete", None, {}
        self.s.db.execute("BEGIN IMMEDIATE")
        try:
            self.save(key, state)
            self.save_job(job)
            self.s.db.execute("COMMIT")
        except Exception:
            self.s.db.execute("ROLLBACK")
            raise
        return {**self.view(state), "receipt": job["id"]}
