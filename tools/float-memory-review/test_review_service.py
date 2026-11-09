import asyncio
import copy
from pathlib import Path
import tempfile
import unittest

from review_service import ReviewError, ReviewService, revision


class Manager:
    def __init__(self):
        self.entries = {}
        self.creates = 0
        self.fail_after = False
        self.fail_before = False

    async def get(self, key):
        row = self.entries.get(key)
        return copy.deepcopy(row) if row and not row["metadata"].get("deleted_at") else None

    def find_exact_content(self, content):
        return next((copy.deepcopy(row) for row in self.entries.values() if row["content"] == content), None)

    async def list_all(self, include_archive=False):
        return [copy.deepcopy(row) for row in self.entries.values() if include_archive or row["metadata"].get("type") != "archived"]

    async def search(self, _query, limit=20):
        return (await self.list_all())[:limit]

    async def touch_many(self, ids, ripple=False):
        for key in ids:
            if key in self.entries:
                meta = self.entries[key]["metadata"]
                meta["activation_count"] = meta.get("activation_count", 0) + 1
                meta["last_active"] = "2026-11-08T01:00:00Z"

    async def create(self, content, bucket_id_override, source_tool, grow_batch_id, **kwargs):
        self.creates += 1
        if self.fail_before:
            raise OSError("synthetic disk failure")
        self.entries[bucket_id_override] = {"id": bucket_id_override, "content": content,
            "metadata": {"source_tool": source_tool, "grow_batch_id": grow_batch_id, "tags": ["原标签"], "type": kwargs.get("bucket_type", "dynamic")}}
        for field in ("dont_surface", "tags", "name", "importance"):
            if field in kwargs:
                self.entries[bucket_id_override]["metadata"][field] = kwargs[field]
        if self.fail_after:
            raise OSError("synthetic post-commit failure")
        await asyncio.sleep(0)
        return bucket_id_override

    async def update(self, key, **kwargs):
        if self.fail_before:
            return False
        item = self.entries[key]
        item["content"] = kwargs.get("content", item["content"])
        if "change_log" in kwargs:
            item["metadata"]["change_log"] = kwargs["change_log"]
        if "dont_surface" in kwargs:
            item["metadata"]["dont_surface"] = kwargs["dont_surface"]
        if "type" in kwargs:
            item["metadata"]["type"] = kwargs["type"]
        if self.fail_after:
            raise OSError("synthetic post-commit failure")
        await asyncio.sleep(0)
        return True

    async def delete(self, key, reason=""):
        item = self.entries[key]
        item["metadata"].update(pre_delete_type=item["metadata"].get("type", "dynamic"), deleted_at="2026-11-08T02:00:00Z", tombstone=True, deleted_reason=reason)
        if getattr(self, "fail_lifecycle_after", False):
            raise OSError("synthetic delete receipt loss")
        return True

    async def restore(self, key):
        meta = self.entries[key]["metadata"]
        meta["type"] = meta.get("pre_delete_type") or meta.get("type", "dynamic")
        for field in ("pre_delete_type", "deleted_at", "tombstone", "deleted_reason"):
            meta.pop(field, None)
        meta["restored_at"] = "2026-11-08T03:00:00Z"
        if getattr(self, "fail_lifecycle_after", False):
            raise OSError("synthetic restore receipt loss")
        return True


class ReviewTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = Manager()
        self.service = ReviewService(self.manager, self.temp.name)

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    async def create_candidate(self, key="create-1", content="尚未批准的合成记忆"):
        return await self.service.propose({"clientKey": key, "kind": "create", "content": content, "source": {"origin": "float_ai", "sessionId": "synthetic"}})

    async def create_approved(self):
        row = await self.create_candidate()
        await self.service.approve(row["id"], row["version"])
        return row["targetId"]

    async def edit(self, target, content, key="edit-1"):
        detail = await self.service.detail(target)
        return await self.service.propose({"clientKey": key, "kind": "edit", "targetId": target,
            "baseRevision": detail["revision"], "content": content, "source": {"origin": "float_user"}})

    async def test_pending_not_formal_and_retry_idempotent(self):
        row = await self.create_candidate()
        self.assertEqual(self.manager.entries, {})
        self.assertEqual((await self.create_candidate())["id"], row["id"])
        self.assertEqual(self.service.candidates()["total"], 1)
        approved = await self.service.approve(row["id"], 1)
        self.assertEqual(approved["state"], "approved")
        await self.service.approve(row["id"], 1)
        self.assertEqual(self.manager.creates, 1)
        self.assertEqual(len(self.service.history(row["targetId"])["history"]), 1)

    async def test_ai_records_automatically_by_default(self):
        self.assertFalse(self.service.policy()["reviewRequired"])
        payload = {"clientKey": "auto-1", "kind": "create", "content": "AI 自动记下的合成事实", "source": {"origin": "cannot_spoof_user"}}
        row = await self.service.record(payload)
        self.assertEqual(row["state"], "approved")
        self.assertEqual(row["source"]["origin"], "float_ai")
        self.assertEqual(self.manager.entries[row["targetId"]]["content"], payload["content"])
        await self.service.record(payload)
        self.assertEqual(self.manager.creates, 1)
        duplicate = await self.service.record({**payload, "clientKey": "same-fact-other-call"})
        self.assertEqual(duplicate["targetId"], row["targetId"])
        self.assertEqual(self.manager.creates, 1, "Automatic identical facts are not copied into a second bucket")
        await self.service.set_policy(True, 1)
        self.assertEqual((await self.service.record(payload))["state"], "approved", "Receipt lookup is safe even while paused")
        with self.assertRaises(ReviewError):
            await self.service.record({**payload, "clientKey": "new-while-paused"})

    async def test_review_is_opt_in_and_user_edits_stay_direct(self):
        await self.service.set_policy(False, 1, True)
        draft = await self.service.record({"clientKey": "ai-optional", "kind": "create", "content": "开启审核后的 AI 合成记忆", "source": {}})
        self.assertEqual(draft["state"], "pending")
        self.assertFalse(self.manager.entries)
        human = await self.service.record({"clientKey": "human-direct", "kind": "create", "content": "人工输入的合成事实", "source": {}}, manual=True)
        self.assertEqual(human["state"], "approved")
        self.assertEqual(human["source"]["origin"], "float_user")
        await self.service.set_policy(True, 2, True)
        edited = await self.service.detail(human["targetId"])
        fixed = await self.service.record({"clientKey": "human-fix", "kind": "edit", "targetId": human["targetId"], "baseRevision": edited["revision"],
            "content": "暂停 AI 期间人工纠错", "source": {}}, manual=True)
        self.assertEqual(fixed["state"], "approved")
        self.assertEqual(self.manager.entries[human["targetId"]]["content"], "暂停 AI 期间人工纠错")

    async def test_direct_undo_and_core_type(self):
        row = await self.service.record({"clientKey": "core", "kind": "create", "content": "合成核心记忆", "source": {"memoryType": "core"}})
        self.assertEqual(self.manager.entries[row["targetId"]]["metadata"]["type"], "permanent")
        original = await self.service.detail(row["targetId"])
        edited = await self.service.record({"clientKey": "direct-edit", "kind": "edit", "targetId": row["targetId"], "baseRevision": original["revision"], "content": "合成纠错正文", "source": {}}, manual=True)
        reverted = await self.service.undo(edited["id"], "direct-undo")
        self.assertEqual(reverted["state"], "approved")
        self.assertEqual(self.manager.entries[row["targetId"]]["content"], "合成核心记忆")

    async def test_active_reads_exclude_drafts_private_and_hidden(self):
        pending = await self.create_candidate()
        self.assertFalse((await self.service.memories())["entries"])
        target = await self.create_approved()
        entries = (await self.service.memories())["entries"]
        self.assertEqual(entries[0]["id"], target)
        self.assertEqual(entries[0]["provenance"]["origin"], "float_ai")
        self.manager.entries[target]["metadata"]["dont_surface"] = True
        self.assertFalse((await self.service.memories("query"))["entries"])
        self.manager.entries[target]["metadata"].pop("dont_surface")
        self.manager.entries[target]["metadata"]["type"] = "feel"
        self.assertFalse((await self.service.memories())["entries"])
        self.assertNotEqual(pending["id"], "")

    async def test_recall_counters_do_not_block_factual_edits(self):
        target = await self.create_approved()
        before = await self.service.detail(target)
        await self.service.recall([target, target])
        after = await self.service.detail(target)
        self.assertEqual(before["revision"], after["revision"])
        self.assertEqual(self.manager.entries[target]["metadata"]["activation_count"], 1)
        edited = await self.service.record({"clientKey": "edit-after-recall", "kind": "edit", "targetId": target, "baseRevision": before["revision"], "content": "召回后仍可人工纠错", "source": {}}, manual=True)
        self.assertEqual(edited["state"], "approved")
        self.assertEqual(self.manager.entries[target]["metadata"]["activation_count"], 1)

    async def test_reject_never_writes(self):
        row = await self.create_candidate()
        await self.service.reject(row["id"], 1)
        with self.assertRaises(ReviewError):
            await self.service.approve(row["id"], 1)
        self.assertFalse(self.manager.entries)

    async def test_revised_candidate_needs_fresh_confirmation(self):
        row = await self.create_candidate()
        updated = await self.service.revise(row["id"], 1, "经人工修正的合成内容")
        with self.assertRaises(ReviewError):
            await self.service.approve(row["id"], 1)
        await self.service.approve(row["id"], updated["version"])
        self.assertEqual(self.manager.entries[row["targetId"]]["content"], "经人工修正的合成内容")

    async def test_concurrent_edit_conflicts_without_overwriting(self):
        target = await self.create_approved()
        a = await self.edit(target, "设备 A 修改", "edit-a")
        b = await self.edit(target, "设备 B 修改", "edit-b")
        await self.service.approve(a["id"], 1)
        with self.assertRaisesRegex(ReviewError, "未覆盖新版"):
            await self.service.approve(b["id"], 1)
        self.assertEqual(self.manager.entries[target]["content"], "设备 A 修改")
        self.assertEqual(self.manager.entries[target]["metadata"]["tags"], ["原标签"])

    async def test_native_coordinated_writer_invalidates_stale_edit(self):
        target = await self.create_approved()
        row = await self.edit(target, "过时修改")
        await self.manager.update(target, content="其他客户端的新内容")
        with self.assertRaises(ReviewError):
            await self.service.approve(row["id"], 1)
        self.assertEqual(self.manager.entries[target]["content"], "其他客户端的新内容")

    async def test_restart_recovery_after_canonical_create(self):
        row = await self.create_candidate()
        self.manager.fail_after = True
        with self.assertRaisesRegex(ReviewError, "未决"):
            await self.service.approve(row["id"], 1)
        self.assertEqual(self.service.candidates()["candidates"][0]["state"], "applying")
        self.service.close()
        self.service = ReviewService(self.manager, self.temp.name)
        self.manager.fail_after = False
        result = await self.service.approve(row["id"], 1)
        self.assertEqual(result["state"], "approved")
        self.assertEqual(self.manager.creates, 1)

    async def test_restart_recovery_after_edit_and_intervening_change(self):
        target = await self.create_approved()
        row = await self.edit(target, "已经写入但回执丢失")
        self.manager.fail_after = True
        with self.assertRaises(ReviewError):
            await self.service.approve(row["id"], 1)
        self.manager.fail_after = False
        result = await self.service.approve(row["id"], 1)
        self.assertEqual(result["state"], "approved")
        other = await self.edit(target, "第二次未决修改", "second-edit")
        self.manager.fail_after = True
        with self.assertRaises(ReviewError):
            await self.service.approve(other["id"], 1)
        self.manager.fail_after = False
        await self.manager.update(target, content="此后被人工修正")
        with self.assertRaises(ReviewError):
            await self.service.approve(other["id"], 1)
        self.assertEqual(self.manager.entries[target]["content"], "此后被人工修正")

    async def test_failed_write_can_resume_only_if_base_unchanged(self):
        target = await self.create_approved()
        row = await self.edit(target, "重新尝试同一操作")
        self.manager.fail_before = True
        with self.assertRaises(ReviewError):
            await self.service.approve(row["id"], 1)
        self.manager.fail_before = False
        self.assertEqual((await self.service.approve(row["id"], 1))["state"], "approved")

    async def test_undo_is_reviewed_and_rejects_later_changes(self):
        target = await self.create_approved()
        original = self.manager.entries[target]["content"]
        row = await self.edit(target, "人工改过的正文")
        await self.service.approve(row["id"], 1)
        undo = await self.service.propose_undo(row["id"], "undo-1")
        self.assertEqual(self.manager.entries[target]["content"], "人工改过的正文")
        await self.service.approve(undo["id"], 1)
        self.assertEqual(self.manager.entries[target]["content"], original)
        with self.assertRaises(ReviewError):
            await self.service.propose_undo(row["id"], "undo-2")

    async def test_pause_is_durable_separate_and_versioned(self):
        row = await self.create_candidate()
        policy = await self.service.set_policy(True, 1)
        with self.assertRaises(ReviewError):
            await self.service.approve(row["id"], 1)
        with self.assertRaises(ReviewError):
            await self.create_candidate("other")
        with self.assertRaises(ReviewError):
            await self.service.set_policy(False, 1)
        self.service.close()
        self.service = ReviewService(self.manager, self.temp.name)
        self.assertTrue(self.service.policy()["paused"])
        await self.service.set_policy(False, policy["version"])
        await self.service.approve(row["id"], 1)

    async def test_idempotency_collision_and_validation(self):
        await self.create_candidate()
        with self.assertRaises(ReviewError):
            await self.create_candidate(content="同编号不同内容")
        for value in ("", "\x00bad", "x" * 12001):
            with self.assertRaises(ReviewError):
                await self.create_candidate("bad-" + str(len(value)), value)
        with self.assertRaises(ReviewError):
            await self.service.detail("../escape")

    async def test_only_one_process_owner(self):
        with self.assertRaisesRegex(RuntimeError, "Only one"):
            ReviewService(Manager(), self.temp.name)
        self.assertFalse(self.manager.entries)

    async def test_simultaneous_approvals_create_once(self):
        row = await self.create_candidate()
        results = await asyncio.gather(*(self.service.approve(row["id"], 1) for _ in range(5)))
        self.assertTrue(all(result["state"] == "approved" for result in results))
        self.assertEqual(self.manager.creates, 1)

    async def manage(self, target, operation, key):
        raw = await self.service._raw(target)
        return await self.service.manage({"targetId": target, "operation": operation, "clientKey": key,
                                         "baseRevision": revision(raw, include_deleted=True)})

    async def test_lifecycle_archive_restore_and_recall_exclusion(self):
        target = await self.create_approved()
        original = self.manager.entries[target]["content"]
        await self.manage(target, "archive", "archive-1")
        self.assertEqual((await self.service.memories())["entries"], [])
        self.assertEqual((await self.service.catalog("archived"))["entries"][0]["content"], original)
        with self.assertRaisesRegex(ReviewError, "不会自动重新建立"):
            await self.service.record({"kind": "create", "clientKey": "no-resurrection", "content": original})
        await self.manage(target, "restore", "unarchive-1")
        self.assertEqual(len((await self.service.memories())["entries"]), 1)
        self.assertEqual(self.manager.entries[target]["content"], original)

    async def test_lifecycle_delete_restore_and_crash_reconciliation(self):
        target = await self.create_approved()
        raw = await self.service._raw(target)
        request = {"targetId": target, "operation": "delete", "clientKey": "delete-1", "baseRevision": revision(raw)}
        self.manager.fail_lifecycle_after = True
        with self.assertRaisesRegex(ReviewError, "未确认"):
            await self.service.manage(request)
        self.assertIsNone(await self.manager.get(target))
        self.assertEqual((await self.service.memories())["entries"], [])
        self.service.close()
        self.service = ReviewService(self.manager, self.temp.name)
        self.manager.fail_lifecycle_after = False
        self.assertEqual((await self.service.manage(request))["state"], "completed")
        self.assertEqual((await self.service.manage(request))["state"], "completed")
        rows = (await self.service.catalog("deleted"))["entries"]
        self.assertEqual(len(rows), 1)
        restore = {"targetId": target, "operation": "restore", "clientKey": "restore-1", "baseRevision": rows[0]["revision"]}
        self.manager.fail_lifecycle_after = True
        with self.assertRaises(ReviewError):
            await self.service.manage(restore)
        self.manager.fail_lifecycle_after = False
        self.assertEqual((await self.service.manage(restore))["state"], "completed")
        self.assertIsNotNone(await self.manager.get(target))

    async def test_lifecycle_stale_versions_and_idempotency_collision(self):
        target = await self.create_approved()
        before = await self.service.detail(target)
        request = {"targetId": target, "operation": "delete", "clientKey": "stale-delete", "baseRevision": before["revision"]}
        await self.manager.update(target, content="已经由另一设备纠正")
        with self.assertRaisesRegex(ReviewError, "未覆盖新版"):
            await self.service.manage(request)
        self.assertIsNotNone(await self.manager.get(target))
        await self.manage(target, "archive", "shared-key")
        with self.assertRaisesRegex(ReviewError, "其他操作"):
            await self.manage(target, "delete", "shared-key")

    async def test_lifecycle_retry_does_not_override_intervening_edit(self):
        target = await self.create_approved()
        request = {"targetId": target, "operation": "delete", "clientKey": "resume-stale", "baseRevision": (await self.service.detail(target))["revision"]}
        self.manager.fail_after = True
        with self.assertRaises(ReviewError):
            await self.service.manage(request)
        self.manager.fail_after = False
        await self.manager.update(target, content="此后被修正，不得再删除")
        with self.assertRaisesRegex(ReviewError, "未覆盖新版"):
            await self.service.manage(request)
        self.assertIsNotNone(await self.manager.get(target))

    async def test_lifecycle_human_management_when_ai_paused_and_catalog_pagination(self):
        target = await self.create_approved()
        self.manager.entries[target]["metadata"]["dont_surface"] = True
        await self.service.set_policy(True, self.service.policy()["version"])
        await self.manage(target, "archive", "paused-archive")
        await self.manage(target, "restore", "paused-restore")
        self.assertTrue(self.manager.entries[target]["metadata"]["dont_surface"], "Restore must preserve the original hidden preference")
        for i in range(105):
            self.manager.entries[f"page-{i:03}"] = {"id": f"page-{i:03}", "content": "虚构分页记忆", "metadata": {}}
        page = await self.service.catalog()
        self.assertEqual(len(page["entries"]), 100)
        self.assertEqual(len((await self.service.catalog(cursor=page["nextCursor"]))["entries"]), 6)

    async def test_real_latent_derived_index_invalidates_on_correction_and_archive(self):
        from float_latent_vendor import MemoryIndex
        self.service.latent_factory = MemoryIndex
        row = await self.service.record({"clientKey": "latent-source", "kind": "create", "content": "她喜欢茉莉花茶。"}, manual=True)
        target = row["targetId"]
        self.assertEqual((await self.service.memories("茉莉花茶", "latent"))["entries"][0]["id"], target)
        cached = self.service.latent_index
        await self.manager.touch_many([target])
        self.assertIs(self.service.latent_index, cached)
        await self.manager.update(target, content="她目前只喝乌龙茶。")
        self.assertIsNone(self.service.latent_index)
        self.assertEqual((await self.service.memories("茉莉花茶", "latent"))["entries"], [])
        self.assertEqual((await self.service.memories("乌龙茶", "latent"))["entries"][0]["content"], "她目前只喝乌龙茶。")
        await self.manage(target, "archive", "latent-archive")
        self.assertEqual((await self.service.memories("乌龙茶", "latent"))["entries"], [])

    async def test_latent_external_change_and_failure_never_return_stale_content(self):
        from float_latent_vendor import MemoryIndex
        self.service.latent_factory = MemoryIndex
        target = (await self.service.record({"clientKey": "latent-external", "kind": "create", "content": "她收藏蓝色月光石。"}, manual=True))["targetId"]
        await self.service.memories("月光石", "latent")
        # A file editor bypassing our wrapper still changes the pool fingerprint.
        self.manager.entries[target]["content"] = "她现在收藏琥珀。"
        self.assertEqual((await self.service.memories("月光石", "latent"))["entries"], [])
        await self.service.memories("琥珀", "latent")
        retriever = self.service.latent_index.retrieve_candidates
        def race(*args, **kwargs):
            hits = retriever(*args, **kwargs)
            self.manager.entries[target]["content"] = "此后被人工纠正的新版"
            return hits
        self.service.latent_index.retrieve_candidates = race
        with self.assertRaisesRegex(ReviewError, "旧索引结果已阻止"):
            await self.service.memories("琥珀", "latent")
        self.service.latent_factory = None
        with self.assertRaisesRegex(ReviewError, "没有改用其他来源"):
            await self.service.memories("琥珀", "latent")


if __name__ == "__main__":
    unittest.main()
