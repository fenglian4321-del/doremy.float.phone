import copy
import tempfile
import unittest

from review_service import ReviewError, ReviewService
from test_review_service import Manager


def note(identifier="one", body="只导入这条虚构记忆", state="conditional"):
    return {"id": identifier, "assistantId": "synthetic-assistant", "body": body, "summary": "虚构摘要", "state": state,
            "previousState": "static", "tags": ["原标签"], "keywords": ["原关键词"], "important": True,
            "minIntervalTurns": 2, "createdAt": 1700000000000, "updatedAt": 1700000001000, "revision": 1, "deleted": False}


class OrbisTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = Manager()
        self.service = ReviewService(self.manager, self.temp.name)

    def tearDown(self):
        self.service.close(); self.temp.cleanup()

    async def test_import_preserves_full_source_metadata_and_static_visibility(self):
        original = note(state="static")
        result = await self.service.orbis.import_note({"batchId": "batch-1", "note": original})
        saved = await self.service.detail(result["targetId"])
        self.assertEqual(saved["content"], original["body"])
        self.assertEqual(saved["metadata"]["tags"], original["tags"])
        self.assertTrue(saved["metadata"]["dont_surface"])
        self.assertEqual(saved["provenance"]["entryMetadata"]["orbis"], {key: value for key, value in original.items() if key != "body"})
        self.assertEqual((await self.service.memories())["entries"], [])
        pinned = await self.service.orbis.import_note({"batchId": "batch-1", "note": note("pin", "虚构核心记忆", "pinned")})
        self.assertEqual((await self.service.detail(pinned["targetId"]))["metadata"]["type"], "permanent")

    async def test_reimport_never_overwrites_user_correction_or_duplicates(self):
        payload = {"batchId": "first-batch", "note": note()}
        result = await self.service.orbis.import_note(payload)
        await self.manager.update(result["targetId"], content="导入后由用户纠正")
        again = await self.service.orbis.import_note({**payload, "batchId": "another-batch"})
        self.assertEqual(again["state"], "existing")
        self.assertEqual(self.manager.creates, 1)
        self.assertEqual(self.manager.entries[result["targetId"]]["content"], "导入后由用户纠正")
        with self.assertRaisesRegex(ReviewError, "不同版本"):
            await self.service.orbis.import_note({**payload, "note": {**note(), "revision": 2, "body": "另一个导出版本"}})

    async def test_batch_rollback_only_new_unchanged_facts(self):
        original = await self.service.record({"kind": "create", "clientKey": "prior", "content": "本来就存在的虚构事实"}, manual=True)
        existing = await self.service.orbis.import_note({"batchId": "batch-undo", "note": note("dup", "本来就存在的虚构事实")})
        self.assertFalse(existing["owned"])
        new = await self.service.orbis.import_note({"batchId": "batch-undo", "note": note("new", "批次新建的虚构事实")})
        edited = await self.service.orbis.import_note({"batchId": "batch-undo", "note": note("edited", "随后要被修改的虚构事实")})
        await self.manager.update(edited["targetId"], content="人工修改后必须保留")
        result = await self.service.orbis.rollback("batch-undo")
        self.assertEqual({row["state"] for row in result["results"]}, {"kept_existing", "rolled_back", "needs_review"})
        self.assertIsNone(await self.manager.get(new["targetId"]))
        self.assertIsNotNone(await self.manager.get(original["targetId"]))
        self.assertIsNotNone(await self.manager.get(edited["targetId"]))
        with self.assertRaisesRegex(ReviewError, "不会.*自动复活"):
            await self.service.orbis.import_note({"batchId": "again", "note": note("new", "批次新建的虚构事实")})

    async def test_crash_after_create_and_after_rollback_can_resume(self):
        payload = {"batchId": "crash-batch", "note": note()}
        self.manager.fail_after = True
        with self.assertRaises(ReviewError):
            await self.service.orbis.import_note(payload)
        self.manager.fail_after = False
        self.service.close(); self.service = ReviewService(self.manager, self.temp.name)
        result = await self.service.orbis.import_note(payload)
        self.assertEqual(self.manager.creates, 1)
        self.manager.fail_lifecycle_after = True
        self.assertEqual((await self.service.orbis.rollback("crash-batch"))["results"][0]["state"], "needs_review")
        self.manager.fail_lifecycle_after = False
        self.assertEqual((await self.service.orbis.rollback("crash-batch"))["results"][0]["state"], "rolled_back")
        self.assertIsNone(await self.manager.get(result["targetId"]))

    async def test_invalid_deleted_chat_fields_or_capacity_never_write(self):
        cases = [{**note(), "messages": ["never import chats"]}, {**note(), "deleted": True}, {**note(), "body": "x" * 12001}, {**note(), "summary": "x" * 4000}, {**note(), "createdAt": "yesterday"}]
        for source in cases:
            with self.assertRaises(ReviewError):
                await self.service.orbis.import_note({"batchId": "invalid", "note": copy.deepcopy(source)})
        self.assertEqual(self.manager.creates, 0)

    async def test_whitespace_normalization_preserves_complete_original_in_audit(self):
        original = note(body="\n  原始空白与正文\n\n")
        result = await self.service.orbis.import_note({"batchId": "white-space", "note": original})
        self.assertEqual(self.manager.entries[result["targetId"]]["content"], "原始空白与正文")
        import json
        saved = self.service.db.execute("SELECT note_json FROM orbis_imports").fetchone()[0]
        self.assertEqual(json.loads(saved)["body"], original["body"])


if __name__ == "__main__":
    unittest.main()
