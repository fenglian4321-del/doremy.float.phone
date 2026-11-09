import hashlib
import tempfile
import unittest
from review_service import ReviewService, ReviewError
from float_private_spaces import PrivateSpaces
from workspace_test_host import NoLifeManager


class PrivateSpaceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.s = ReviewService(NoLifeManager(), self.tmp.name)

    def tearDown(self):
        self.assertEqual(self.s.db.execute("SELECT COUNT(*) FROM candidates").fetchone()[0], 0)
        self.assertEqual(self.s.db.execute("SELECT COUNT(*) FROM consolidation_scopes").fetchone()[0], 0)
        self.s.close()
        self.tmp.cleanup()

    async def call(self, operation, kind="private", key="same-id", **payload):
        service = self.s.private_spaces if kind == "private" else self.s.workspaces
        return await service.dispatch(dict(operation=operation, **({} if operation in ("create", "list") else dict(workspaceId=key)), **payload))

    async def create(self, kind="private"):
        return await self.call("create", kind=kind, title="私人日记" if kind == "private" else "工作项目", clientKey="same-id")

    async def begin(self, kind="private", refs=None, client="send-a"):
        state = (await self.call("detail", kind=kind))["workspace"]
        return await self.call("begin", kind=kind, content="整理本区材料", version=state["version"], clientKey=client, claim="secret-a", model="selected-model", apiFingerprint="f"*64, **({"attachments": refs} if refs is not None else {}))

    async def test_namespaces_and_protocol_are_separate_even_with_same_id(self):
        a, b = await self.create(), await self.create("work")
        self.assertEqual(a["protocol"], "float-private-spaces/v1")
        self.assertEqual(b["workspace"]["mode"], "work")
        await self.call("write_file", path="notes/secret.md", content="PRIVATE_ONLY", baseVersion=0)
        await self.call("write_file", kind="work", path="notes/secret.md", content="WORK_ONLY", baseVersion=0)
        self.assertEqual((await self.call("read_file", path="notes/secret.md"))["result"]["content"], "PRIVATE_ONLY")
        self.assertEqual((await self.call("read_file", kind="work", path="notes/secret.md"))["result"]["content"], "WORK_ONLY")
        listed = await self.call("list")
        self.assertNotIn("工作项目", str(listed))
        self.assertNotIn("PRIVATE_ONLY", str(listed))

    async def test_private_tools_cannot_call_work_or_life(self):
        await self.create()
        run = (await self.begin())["run"]["id"]
        for name in ("workspace_read_file", "float_memory_pulse", "memory_write", "mcp"):
            with self.assertRaises(ReviewError):
                await self.call("turn", runId=run, claim="secret-a", turnKey="turn-a", assistant=dict(role="assistant", content="", toolCalls=[dict(id="call-a", name=name, args={})]))
        result = await self.call("turn", runId=run, claim="secret-a", turnKey="turn-a", assistant=dict(role="assistant", content="", toolCalls=[dict(id="call-a", name="private_write_file", args=dict(path="diary/entry.md", content="这是私人创作记录，不是用户事实。", baseVersion=0))]))
        self.assertIn("私人写作空间", result["run"]["messages"][0]["content"])
        result = await self.call("tool", runId=run, claim="secret-a", turn=1, callId="call-a")
        self.assertTrue(result["result"]["ok"])
        self.assertEqual(result["result"]["location"], "server_private_space")

    async def test_namespace_is_not_request_controlled(self):
        await self.create()
        with self.assertRaises(ReviewError):
            await self.call("read_file", path="x.md", mode="work")
        class InvalidNamespace(PrivateSpaces):
            TABLE = "workspaces"
        with self.assertRaises(RuntimeError):
            InvalidNamespace(self.s.db, self.s.writer, ReviewError)

    async def test_selected_attachment_pins_source_and_not_other_namespace(self):
        await self.create()
        await self.create("work")
        await self.call("write_file", path="notes/source.md", content="PRIVATE_ATTACHMENT_V1", baseVersion=0)
        await self.call("write_file", kind="work", path="notes/source.md", content="WORK_NOT_SELECTED", baseVersion=0)
        first = await self.begin(refs=[dict(path="notes/source.md", version=1)])
        run = first["run"]["id"]
        self.assertIn("PRIVATE_ATTACHMENT_V1", str(first["run"]["messages"]))
        self.assertNotIn("WORK_NOT_SELECTED", str(first))
        metadata = first["workspace"]["messages"][0]["attachments"][0]
        self.assertEqual(metadata["digest"], hashlib.sha256(b"PRIVATE_ATTACHMENT_V1").hexdigest())
        self.assertNotIn("content", metadata)
        await self.call("write_file", path="notes/source.md", content="PRIVATE_ATTACHMENT_V2", baseVersion=1)
        state = (await self.call("detail"))["workspace"]
        retry = await self.call("begin", version=state["version"], content="整理本区材料", clientKey="send-a", claim="secret-a", model="selected-model", apiFingerprint="f"*64, attachments=[dict(path="notes/source.md", version=1)])
        self.assertEqual(retry["run"]["id"], run)
        self.assertIn("PRIVATE_ATTACHMENT_V1", str(retry["run"]["messages"]))
        self.assertNotIn("PRIVATE_ATTACHMENT_V2", str(retry["run"]["messages"]))

    async def test_attachment_selection_and_versions_are_explicit(self):
        await self.create()
        await self.call("write_file", path="notes/source.md", content="NOT_AUTO_INCLUDED", baseVersion=0)
        empty = await self.begin()
        self.assertNotIn("NOT_AUTO_INCLUDED", str(empty["run"]["messages"]))
        await self.call("close", runId=empty["run"]["id"], claim="secret-a")
        for refs in ([dict(path="notes/source.md", version=2)], [dict(path="../outside.md", version=1)], [dict(path="notes/source.md", version=1)]*2, [dict(path=f"file-{i}.md", version=1) for i in range(7)]):
            with self.assertRaises(ReviewError):
                await self.begin(refs=refs, client="bad-ref")
        self.assertEqual(len((await self.call("detail"))["workspace"]["messages"]), 1)

    async def test_future_turns_do_not_automatically_reload_old_attachment_bodies(self):
        await self.create()
        await self.call("write_file", path="notes/source.md", content="SOURCE_TEXT_ONLY_SELECTED_ONCE", baseVersion=0)
        first = await self.begin(refs=[dict(path="notes/source.md", version=1)])
        await self.call("finish", runId=first["run"]["id"], claim="secret-a", content="已整理")
        second = await self.begin(client="next-turn")
        self.assertNotIn("SOURCE_TEXT_ONLY_SELECTED_ONCE", str(second["run"]["messages"]))
        self.assertIn("附件引用记录", str(second["run"]["messages"]))


if __name__ == "__main__":
    unittest.main()
