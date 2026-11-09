import copy
import json
import tempfile
import unittest
from float_consolidation import digest, DEFAULTS, PROTOCOL
from review_service import ReviewService, ReviewError
from test_review_service import Manager


class ConsolidationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.manager = Manager()
        self.service = ReviewService(self.manager, self.tmp.name)
        self.scope = dict(kind="chat", sessionId="synthetic-chat", actorId="role-a")
        self.claim = "synthetic-secret-claim"

    def tearDown(self):
        self.service.close()
        self.tmp.cleanup()

    async def call(self, operation, **kwargs):
        return await self.service.consolidation.dispatch(dict(scope=self.scope, operation=operation, **kwargs))

    def record(self, i=1, text="我下周二去看画展。", role="user"):
        row = dict(id=digest(str(i)), role=role, actor="user" if role == "user" else "role-a", parts=[dict(id=f"message-{i}", text=text, at="2026-11-09T00:00:00Z")], tokens=20)
        row["digest"] = digest([row["role"], row["actor"], [[p["id"], p["text"], p["at"]] for p in row["parts"]]])
        return row

    async def observe(self, records, **kwargs):
        return await self.call("observe", records=[{k: v for k, v in r.items() if k != "parts"} for r in records], **kwargs)

    async def prepare(self, records):
        await self.observe(records)
        return (await self.call("prepare", claim=self.claim, available=[r["id"] for r in records], budget=10000, immediate=True))["job"]

    def decision(self, job, remember=False):
        return dict(protocol=PROTOCOL, jobId=job["id"], inputDigest=job["inputDigest"], decision="remember" if remember else "none", reason="有直接证据" if remember else "不值得长期保存", summary=[dict(text="下周二看画展", refs=["r1"])], facts=[dict(content="用户计划下周二看画展。", kind="user_fact", evidence=[dict(ref="r1", quote="我下周二去看画展。")])] if remember else [])

    async def stage(self, records, job, decision=None):
        return await self.call("stage", claim=self.claim, jobId=job["id"], records=records, decision=decision or self.decision(job))

    async def test_threshold_dedup_no_auto_model_and_none_success(self):
        config = {**DEFAULTS, "count": 2}
        await self.call("configure", version=1, config=config)
        a, b = self.record(), self.record(2)
        result = await self.observe([a])
        self.assertFalse(result["due"])
        result = await self.observe([a])
        self.assertEqual(result["count"], 1)
        result = await self.observe([b])
        self.assertTrue(result["due"])
        job = (await self.call("prepare", claim=self.claim, available=[a["id"], b["id"]], budget=10000))["job"]
        result = await self.stage([a, b], job)
        self.assertEqual(result["pending"], 0)
        self.assertEqual(self.manager.creates, 0)
        self.assertEqual(result["lastSuccess"]["decision"], "none")

    async def test_edit_not_new_count_and_invalidates_summary(self):
        record = self.record()
        job = await self.prepare([record])
        await self.stage([record], job)
        edited = self.record(text="我不去画展了。")
        edited["baseVersion"] = 1
        result = await self.observe([edited])
        self.assertEqual((result["count"], result["dirty"], result["summary"]), (0, 1, []))
        stale = await self.observe([record])
        self.assertEqual(stale["conflicts"], [record["id"]])

    async def test_concurrent_claim_cancel_and_missing_decision(self):
        r = self.record()
        job = await self.prepare([r])
        with self.assertRaises(ReviewError):
            await self.call("prepare", claim="other-device", available=[r["id"]], budget=10000)
        with self.assertRaises(ReviewError):
            await self.call("resume", jobId=job["id"], claim=self.claim)
        result = await self.call("abandon", jobId=job["id"], claim=self.claim)
        self.assertEqual(result["pending"], 1)
        self.assertIsNone(result["lastSuccess"])

    async def test_proof_quote_and_summary_never_become_fact(self):
        r = self.record()
        job = await self.prepare([r])
        bad = self.decision(job, True)
        bad["facts"][0]["evidence"][0]["quote"] = "我喜欢你"
        with self.assertRaises(ReviewError):
            await self.stage([r], job, bad)
        forged = copy.deepcopy(r)
        forged["parts"][0]["text"] = "我喜欢你"
        with self.assertRaises(ReviewError):
            await self.stage([forged], job)
        self.assertEqual(self.manager.creates, 0)
        self.assertEqual((await self.call("status"))["pending"], 1)

    async def test_partial_write_receipt_loss_restart_and_idempotent_resume(self):
        r = self.record()
        job = await self.prepare([r])
        self.manager.fail_after = True
        with self.assertRaises(ReviewError):
            await self.stage([r], job, self.decision(job, True))
        self.assertEqual(self.manager.creates, 1)
        self.service.close()
        self.service = ReviewService(self.manager, self.tmp.name)
        self.manager.fail_after = False
        result = await self.call("resume", jobId=job["id"], claim=self.claim)
        self.assertEqual(result["pending"], 0)
        await self.call("resume", jobId=job["id"], claim="other-device")
        self.assertEqual(self.manager.creates, 1)
        self.assertEqual(len(self.manager.entries), 1)
        # Control-plane DB does not contain the raw conversation payload.
        raw = self.service.db.execute("SELECT state FROM consolidation_scopes").fetchone()[0]
        self.assertNotIn("我下周二去看画展", raw)

    async def test_human_edit_wins_after_partial_commit(self):
        r = self.record()
        job = await self.prepare([r])
        self.manager.fail_after = True
        with self.assertRaises(ReviewError):
            await self.stage([r], job, self.decision(job, True))
        next(iter(self.manager.entries.values()))["content"] = "人工纠正的内容"
        self.manager.fail_after = False
        with self.assertRaises(ReviewError):
            await self.call("resume", jobId=job["id"], claim=self.claim)
        self.assertEqual((await self.call("status"))["pending"], 1)

    async def test_new_arrival_and_midflight_source_edit(self):
        a, b = self.record(), self.record(2)
        job = await self.prepare([a])
        await self.observe([b])
        result = await self.stage([a], job)
        self.assertEqual(result["pending"], 1)
        job2 = (await self.call("prepare", claim=self.claim, available=[b["id"]], budget=10000, immediate=True))["job"]
        edited = self.record(2, text="改过的原文")
        edited["baseVersion"] = 1
        await self.observe([edited])
        with self.assertRaises(ReviewError):
            await self.stage([b], job2)
        self.assertEqual((await self.call("status"))["pending"], 1)

    async def test_review_required_waits_and_resumes_without_model(self):
        r = self.record()
        await self.service.set_policy(False, 1, True)
        job = await self.prepare([r])
        result = await self.stage([r], job, self.decision(job, True))
        self.assertEqual(result["pending"], 1)
        candidate = self.service.candidates()["candidates"][0]
        await self.service.approve(candidate["id"], candidate["version"], manual=True)
        result = await self.call("resume", jobId=job["id"], claim=self.claim)
        self.assertEqual(result["pending"], 0)

    async def test_budget_no_skip_missing_device_and_scope_isolation(self):
        r = self.record()
        await self.observe([r])
        with self.assertRaises(ReviewError):
            await self.call("prepare", claim=self.claim, available=[], budget=10000, immediate=True)
        with self.assertRaises(ReviewError):
            await self.call("prepare", claim=self.claim, available=[r["id"]], budget=1, immediate=True)
        self.scope = {**self.scope, "actorId": "role-b"}
        self.assertEqual((await self.call("status"))["pending"], 0)

    async def test_final_metadata_transaction_failure_is_recoverable(self):
        r = self.record()
        job = await self.prepare([r])
        control = self.service.consolidation
        original = control.save
        def fail_final(key, state):
            if state["lastSuccess"]:
                raise OSError("synthetic watermark disk failure")
            return original(key, state)
        control.save = fail_final
        with self.assertRaises(OSError):
            await self.stage([r], job, self.decision(job, True))
        self.assertEqual(control.job(job["id"])["state"], "staged")
        self.assertEqual((await self.call("status"))["pending"], 1)
        control.save = original
        self.assertEqual((await self.call("resume", jobId=job["id"], claim=self.claim))["pending"], 0)
        self.assertEqual(self.manager.creates, 1)

    async def test_expired_lease_and_other_device_explicit_recovery(self):
        r = self.record()
        job = await self.prepare([r])
        with self.assertRaises(ReviewError):
            await self.call("adopt", jobId=job["id"], claim="device-b")
        stored = self.service.consolidation.job(job["id"])
        stored["expires"] = 0
        self.service.consolidation.save_job(stored)
        with self.assertRaises(ReviewError):
            await self.stage([r], job)
        await self.call("adopt", jobId=job["id"], claim="device-b")
        with self.assertRaises(ReviewError):
            await self.stage([r], job)
        result = await self.call("abandon", jobId=job["id"], claim="device-b")
        self.assertEqual(result["pending"], 1)

    async def test_token_threshold_manual_off_and_no_empty_manual_queue(self):
        await self.call("configure", version=1, config={**DEFAULTS, "count": 100, "tokenThreshold": 20, "manual": False})
        result = await self.observe([self.record()])
        self.assertTrue(result["due"])
        with self.assertRaises(ReviewError):
            await self.call("queue")
        self.scope = {**self.scope, "sessionId": "empty-chat"}
        result = await self.call("prepare", claim=self.claim, available=[], budget=10000, immediate=True)
        self.assertFalse(result["queued"])
        self.assertIsNone(result["job"])

    async def test_retraction_cas_does_not_resurrect_or_recall(self):
        r = self.record()
        job = await self.prepare([r])
        await self.stage([r], job)
        result = await self.call("observe", removed=[dict(id=r["id"], baseVersion=1)])
        self.assertEqual((result["pending"], result["summary"]), (0, []))
        result = await self.observe([r])
        self.assertEqual(result["conflicts"], [r["id"]])

    async def test_two_facts_failure_on_second_no_duplicate_first(self):
        r = self.record()
        job = await self.prepare([r])
        decision = self.decision(job, True)
        decision["facts"].append({**decision["facts"][0], "content": "用户提到了看画展的计划。"})
        original_record = self.service.record
        calls = 0
        async def second_failure(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("synthetic failure between facts")
            return await original_record(*args, **kwargs)
        self.service.record = second_failure
        with self.assertRaises(OSError):
            await self.stage([r], job, decision)
        self.assertEqual((self.manager.creates, (await self.call("status"))["pending"]), (1, 1))
        self.service.record = original_record
        await self.call("adopt", jobId=job["id"], claim="device-b")
        result = await self.call("resume", jobId=job["id"], claim="device-b")
        self.assertEqual((result["pending"], self.manager.creates), (0, 2))

    async def test_partial_budget_retains_trigger_for_remaining_prefix(self):
        await self.call("configure", version=1, config={**DEFAULTS, "count": 2})
        a, b = self.record(), self.record(2)
        await self.observe([a, b])
        job = (await self.call("prepare", claim=self.claim, available=[a["id"], b["id"]], budget=20))["job"]
        result = await self.stage([a], job)
        self.assertEqual((result["count"], result["pending"], result["due"]), (1, 1, True))
        second = (await self.call("prepare", claim="next-natural-reply", available=[b["id"]], budget=20))["job"]
        self.assertIsNotNone(second)


if __name__ == "__main__":
    unittest.main()
