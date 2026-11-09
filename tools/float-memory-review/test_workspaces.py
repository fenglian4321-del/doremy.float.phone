import copy
import json
import sqlite3
import tempfile
import unittest
from review_service import ReviewService, ReviewError
from test_review_service import Manager
from float_workspaces import Workspaces
from review_service import WriterLock


class WorkspaceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.manager = Manager()
        self.manager.entries["life-sentinel"] = dict(id="life-sentinel", content="PRIVATE_LIFE_SENTINEL", metadata={"type": "permanent"})
        self.initial = copy.deepcopy(self.manager.entries)
        self.s = ReviewService(self.manager, self.tmp.name)

    def tearDown(self):
        self.assertEqual(self.manager.entries, self.initial)
        self.assertEqual(self.s.db.execute("SELECT COUNT(*) FROM candidates").fetchone()[0], 0)
        self.s.close()
        self.tmp.cleanup()

    async def call(self, operation, workspaceId="work-a", **args):
        return await self.s.workspaces.dispatch(dict(operation=operation, **({} if operation in ("create", "list") else {"workspaceId": workspaceId}), **args))

    async def create(self, key="work-a"):
        return await self.call("create", title="合成工作项目", clientKey=key)

    async def begin(self, key="work-a", client="request-a"):
        current = (await self.call("detail", workspaceId=key))["workspace"]
        return await self.call("begin", workspaceId=key, version=current["version"], content="写一份工作笔记", clientKey=client, claim="secret-a", model="selected-model", apiFingerprint="f"*64)

    async def turn(self, run, calls=None, **extra):
        return await self.call("turn", runId=run, claim="secret-a", turnKey="turn-a", assistant=dict(role="assistant", content="", toolCalls=calls or [dict(id="call-a", name="workspace_write_file", args=dict(path="notes/plan.md", content="合成工作内容", baseVersion=0))], **extra))

    async def test_work_only_schema_scope_and_no_life_reads(self):
        await self.create()
        result = await self.begin()
        self.assertEqual(result["workspace"]["mode"], "work")
        self.assertNotIn("PRIVATE_LIFE_SENTINEL", str(result))
        for op in ("recall", "record", "consolidation", "codex", "execute", "life_memory"):
            with self.assertRaises(ReviewError):
                await self.call(op, runId=result["run"]["id"], claim="secret-a")
        with self.assertRaises(ReviewError):
            await self.turn(result["run"]["id"], [dict(id="evil", name="float_memory_pulse", args={})])
        with self.assertRaises(ReviewError):
            await self.call("read_file", path="plan.md", characterId="life-role")

    async def test_file_cas_traversal_and_workspace_boundaries(self):
        await self.create()
        await self.create("work-b")
        for path in ("../life", "/life", "a/../../x", "a\\x", "C:/life", "a//b"):
            with self.assertRaises(ReviewError):
                await self.call("write_file", path=path, content="x", baseVersion=0)
        result = await self.call("write_file", path="notes/plan.md", content="人工工作笔记", baseVersion=0)
        self.assertEqual(result["result"]["version"], 1)
        with self.assertRaises(ReviewError):
            await self.call("write_file", path="notes/plan.md", content="旧版覆盖", baseVersion=0)
        with self.assertRaises(ReviewError):
            await self.call("read_file", workspaceId="work-b", path="notes/plan.md")
        self.assertEqual((await self.call("read_file", path="notes/plan.md"))["result"]["content"], "人工工作笔记")

    async def test_begin_dedup_concurrent_and_strict_request_scope(self):
        await self.create()
        a = await self.begin()
        b = await self.begin()
        self.assertEqual(a["run"]["id"], b["run"]["id"])
        self.assertEqual(len(b["workspace"]["messages"]), 1)
        with self.assertRaises(ReviewError):
            await self.begin(client="request-b")
        await self.create("work-b")
        with self.assertRaises(ReviewError):
            await self.call("resume", workspaceId="work-b", runId=a["run"]["id"], claim="secret-a")

    async def test_tool_round_receipts_restart_and_finish_idempotency(self):
        await self.create()
        run = (await self.begin())["run"]["id"]
        await self.turn(run)
        first = await self.call("tool", runId=run, claim="secret-a", turn=1, callId="call-a")
        self.s.close()
        self.s = ReviewService(self.manager, self.tmp.name)
        replay = await self.call("tool", runId=run, claim="secret-a", turn=1, callId="call-a")
        self.assertEqual(first["result"], replay["result"])
        self.assertEqual(replay["result"]["version"], 1)
        self.assertEqual(len([m for m in replay["run"]["messages"] if m["role"] == "tool"]), 1)
        self.assertEqual(replay["run"]["messages"][-1]["toolCallId"], "call-a")
        done = await self.call("finish", runId=run, claim="secret-a", content="笔记已保存到服务端工作区。")
        again = await self.call("finish", runId=run, claim="secret-a", content="笔记已保存到服务端工作区。")
        self.assertEqual(len(again["workspace"]["messages"]), 2)
        self.assertEqual(done["run"]["state"], "complete")
        with self.assertRaises(ReviewError):
            await self.call("finish", runId=run, claim="secret-a", content="另一份回复")

    async def test_partial_tool_cancel_and_explicit_adoption(self):
        await self.create()
        run = (await self.begin())["run"]["id"]
        with self.assertRaises(ReviewError):
            await self.call("adopt", runId=run, claim="device-b")
        await self.turn(run, [dict(id="one", name="workspace_write_file", args=dict(path="one.md", content="one", baseVersion=0)), dict(id="two", name="workspace_write_file", args=dict(path="two.md", content="two", baseVersion=0))])
        await self.call("tool", runId=run, claim="secret-a", turn=1, callId="one")
        await self.call("cancel", runId=run, claim="secret-a")
        with self.assertRaises(ReviewError):
            await self.call("tool", runId=run, claim="secret-a", turn=1, callId="two")
        adopted = await self.call("adopt", runId=run, claim="device-b")
        self.assertEqual(adopted["run"]["pending"][0]["id"], "two")
        result = await self.call("tool", runId=run, claim="device-b", turn=1, callId="two")
        self.assertEqual(len(result["workspace"]["files"]), 2)

    async def test_atomic_file_and_receipt_failure(self):
        await self.create()
        run = (await self.begin())["run"]["id"]
        await self.turn(run)
        original = self.s.workspaces.save
        def failure(*_):
            raise OSError("synthetic transaction failure")
        self.s.workspaces.save = failure
        with self.assertRaises(OSError):
            await self.call("tool", runId=run, claim="secret-a", turn=1, callId="call-a")
        self.s.workspaces.save = original
        self.assertEqual((await self.call("detail"))["workspace"]["files"], [])
        result = await self.call("tool", runId=run, claim="secret-a", turn=1, callId="call-a")
        self.assertEqual(result["result"]["version"], 1)

    async def test_human_file_edit_wins_and_error_is_tool_result(self):
        await self.create()
        run = (await self.begin())["run"]["id"]
        await self.turn(run)
        await self.call("write_file", path="notes/plan.md", content="人工新版", baseVersion=0)
        result = await self.call("tool", runId=run, claim="secret-a", turn=1, callId="call-a")
        self.assertFalse(result["result"]["ok"])
        self.assertEqual(result["result"]["code"], "work_file_conflict")
        self.assertEqual((await self.call("read_file", path="notes/plan.md"))["result"]["content"], "人工新版")

    async def test_archive_limits_and_no_life_policy_dependency(self):
        await self.create()
        await self.s.set_policy(True, 1)
        await self.call("write_file", path="own.md", content="work only", baseVersion=0)
        for content in ("x"*32769, "bad\x00text"):
            with self.assertRaises(ReviewError):
                await self.call("write_file", path="large.md", content=content, baseVersion=0)
        state = (await self.call("detail"))["workspace"]
        await self.call("archive", version=state["version"], archived=True)
        with self.assertRaises(ReviewError):
            await self.begin()
        self.assertEqual((await self.call("read_file", path="own.md"))["result"]["content"], "work only")

    async def test_cancelled_heartbeat_and_stale_generation_cannot_restart(self):
        await self.create()
        run = (await self.begin())["run"]["id"]
        await self.call("cancel", runId=run, claim="secret-a")
        with self.assertRaises(ReviewError):
            await self.call("heartbeat", runId=run, claim="secret-a")
        inspected = await self.call("resume", runId=run, claim="secret-a")
        self.assertEqual(inspected["run"]["state"], "cancelled")
        await self.call("adopt", runId=run, claim="new-execution-epoch")
        with self.assertRaises(ReviewError):
            await self.call("finish", runId=run, claim="secret-a", content="过时模型结果")
        final = await self.call("finish", runId=run, claim="new-execution-epoch", content="当前模型结果")
        self.assertEqual(final["workspace"]["messages"][-1]["content"], "当前模型结果")

    async def test_ambiguous_begin_lookup_and_tool_round_limit(self):
        await self.create()
        missing = await self.call("lookup", clientKey="not-accepted", claim="secret-a")
        self.assertNotIn("run", missing)
        created = await self.begin()
        run = created["run"]["id"]
        looked = await self.call("lookup", clientKey="request-a", claim="secret-a")
        self.assertEqual(looked["run"]["id"], run)
        for index in range(8):
            await self.call("turn", runId=run, claim="secret-a", turnKey=f"turn-{index}", assistant=dict(role="assistant", content="", toolCalls=[dict(id="same-provider-id", name="workspace_list_files", args={})]))
            await self.call("tool", runId=run, claim="secret-a", turn=index+1, callId="same-provider-id")
        with self.assertRaises(ReviewError):
            await self.turn(run)
        final = await self.call("finish", runId=run, claim="secret-a", content="8轮之后的最终回复")
        self.assertEqual(final["run"]["state"], "complete")
        self.assertEqual(final["run"]["messages"], [])

    async def test_metadata_migration_preserves_work_bodies(self):
        await self.create()
        await self.call("write_file", path="private.md", content="WORK_BODY_NOT_FOR_LIST", baseVersion=0)
        state = self.s.workspaces.load("work-a")
        database = sqlite3.connect(":memory:", isolation_level=None)
        database.execute("CREATE TABLE workspaces(id TEXT PRIMARY KEY,state TEXT NOT NULL)")
        database.execute("INSERT INTO workspaces VALUES(?,?)", (state["id"], json.dumps(state)))
        migrated = Workspaces(database, WriterLock(), ReviewError)
        listed = await migrated.dispatch(dict(operation="list"))
        self.assertNotIn("WORK_BODY_NOT_FOR_LIST", str(listed))
        self.assertEqual(migrated.load("work-a")["files"]["private.md"]["content"], "WORK_BODY_NOT_FOR_LIST")
        database.close()


if __name__ == "__main__":
    unittest.main()
