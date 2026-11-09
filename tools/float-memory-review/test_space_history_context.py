import copy
import json
import tempfile
import unittest
from review_service import ReviewService, ReviewError
from test_review_service import Manager


class HistoryContextTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.manager = Manager()
        self.original = copy.deepcopy(self.manager.entries)
        self.s = ReviewService(self.manager, self.tmp.name)

    def tearDown(self):
        self.assertEqual(self.manager.entries, self.original)
        self.assertEqual(self.s.db.execute("SELECT COUNT(*) FROM candidates").fetchone()[0], 0)
        self.s.close()
        self.tmp.cleanup()

    async def call(self, op, kind="work", key="same", **fields):
        service = self.s.workspaces if kind == "work" else self.s.private_spaces
        return await service.dispatch(dict(operation=op, **({} if op in ("create", "list") else dict(workspaceId=key)), **fields))

    async def create(self, kind="work", key="same"):
        return await self.call("create", kind, key, title="合成空间", clientKey=key)

    async def write(self, text, base, kind="work", **more):
        return await self.call("write_file", kind, path="notes/a.md", content=text, baseVersion=base, **more)

    async def chats(self, count=6, kind="work", offset=0):
        for i in range(offset, offset + count):
            w = (await self.call("detail", kind))["workspace"]
            b = await self.call("begin", kind, version=w["version"], content="用户任务"+str(i), clientKey="chat-"+str(i), claim="lease", model="fixture", apiFingerprint="a"*64)
            await self.call("finish", kind, runId=b["run"]["id"], claim="lease", content="完成了合成步骤"+str(i))

    async def compress(self, kind="work", client="sum-a"):
        w = (await self.call("detail", kind))["workspace"]
        return await self.call("compress_begin", kind, version=w["version"], clientKey=client, claim="summary-lease", model="fixture", apiFingerprint="a"*64)

    def decision(self, result, **overrides):
        raw = json.loads(result["run"]["messages"][1]["content"])
        refs = [raw["records"][0]["id"]] + (["previous"] if raw["previous"] else [])
        return json.dumps(dict(protocol="float-space-summary/v1", runId=result["run"]["id"], segments=[dict(text="合成任务摘要，仍需核对文件当前版本。", refs=refs)], **overrides), ensure_ascii=False)

    async def test_history_restore_cas_replay_and_namespace(self):
        for kind in ("work", "private"):
            await self.create(kind)
            await self.write(kind+"-v1", 0, kind)
            await self.write(kind+"-v2", 1, kind)
            history = await self.call("file_history", kind, path="notes/a.md")
            self.assertEqual([r["version"] for r in history["fileHistory"]["versions"]], [2, 1])
            old = await self.call("read_file_version", kind, path="notes/a.md", version=1)
            self.assertEqual(old["result"]["content"], kind+"-v1")
            args = dict(path="notes/a.md", baseVersion=2, targetVersion=1, clientKey="restore-same")
            a = await self.call("restore_file", kind, **args)
            self.assertEqual(a["restored"]["version"], 3)
            await self.write("human-v4", 3, kind)
            replay = await self.call("restore_file", kind, **args)
            self.assertTrue(replay["restored"]["replayed"])
            self.assertEqual(replay["workspace"]["files"][0]["version"], 4)
            with self.assertRaises(ReviewError):
                await self.call("restore_file", kind, **{**args, "clientKey": "new-stale"})
            with self.assertRaises(ReviewError):
                await self.call("restore_file", kind, **{**args, "baseVersion": 4})
            self.assertEqual((await self.call("read_file", kind, path="notes/a.md"))["result"]["content"], "human-v4")

    async def test_history_legacy_baseline_and_atomic_failure(self):
        await self.create()
        await self.write("legacy-current", 0)
        self.s.db.execute("DELETE FROM workspaces_file_versions")
        history = await self.call("file_history", path="notes/a.md")
        self.assertEqual(history["fileHistory"]["versions"][0]["source"], "existing")
        self.s.db.executescript("CREATE TEMP TRIGGER fixture_fail BEFORE INSERT ON workspaces_file_versions WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'fixture failure'); END;")
        with self.assertRaises(Exception):
            await self.write("not-committed", 1)
        self.assertEqual((await self.call("read_file", path="notes/a.md"))["result"]["version"], 1)
        self.assertEqual(self.s.db.execute("SELECT COUNT(*) FROM workspaces_file_versions").fetchone()[0], 0)
        self.s.db.execute("DROP TRIGGER fixture_fail")
        await self.write("now-saved", 1)
        self.assertEqual((await self.call("read_file_version", path="notes/a.md", version=1))["result"]["content"], "legacy-current")

    async def test_history_bounds_and_archived_read_only(self):
        await self.create()
        for i in range(128):
            await self.write(str(i), i)
        with self.assertRaises(ReviewError) as error:
            await self.write("over", 128)
        self.assertEqual(error.exception.code, "work_history_capacity")
        w = (await self.call("detail"))["workspace"]
        await self.call("archive", version=w["version"], archived=True)
        self.assertEqual(len((await self.call("file_history", path="notes/a.md"))["fileHistory"]["versions"]), 128)
        with self.assertRaises(ReviewError):
            await self.call("restore_file", path="notes/a.md", baseVersion=128, targetVersion=1, clientKey="archived")

    async def test_compress_retains_raw_recent_and_scope(self):
        for kind in ("work", "private"):
            await self.create(kind)
            await self.chats(kind=kind)
            before = (await self.call("detail", kind))["workspace"]["messages"]
            b = await self.compress(kind)
            self.assertEqual(b["run"]["kind"], "compression")
            task = json.loads(b["run"]["messages"][1]["content"])
            self.assertEqual(len(task["records"]), 4)
            done = await self.call("compress_finish", kind, runId=b["run"]["id"], claim="summary-lease", content=self.decision(b))
            self.assertEqual(done["workspace"]["messages"], before)
            self.assertTrue(done["workspace"]["context"]["enabled"])
            next_run = await self.call("begin", kind, version=done["workspace"]["version"], content="继续", clientKey="next", claim="lease", model="fixture", apiFingerprint="a"*64)
            prompt = next_run["run"]["messages"]
            self.assertNotIn("用户任务0", str(prompt))
            self.assertIn("用户任务2", str(prompt))
            self.assertIn("合成任务摘要", str(prompt))
            self.assertEqual(len(prompt), 11)  # rules + summary + last eight + new user
            with self.assertRaises(ReviewError):
                await self.call("compress_finish", "private" if kind == "work" else "work", runId=b["run"]["id"], claim="summary-lease", content=self.decision(b))

    async def test_compression_validation_recovery_and_no_chat_tools(self):
        await self.create()
        await self.chats()
        b = await self.compress()
        same = await self.compress()
        self.assertEqual(same["run"]["id"], b["run"]["id"])
        auth = dict(runId=b["run"]["id"], claim="summary-lease")
        for raw in ("invalid", json.dumps(dict(protocol="float-space-summary/v1", runId=b["run"]["id"], segments=[dict(text="来自其他区", refs=["life-fact"])]))):
            with self.assertRaises(ReviewError):
                await self.call("compress_finish", **auth, content=raw)
        self.assertIsNone((await self.call("detail"))["workspace"]["context"]["summary"])
        with self.assertRaises(ReviewError):
            await self.call("finish", **auth, content="不能当作普通聊天完成")
        await self.call("cancel", **auth)
        with self.assertRaises(ReviewError):
            await self.call("compress_finish", **auth, content=self.decision(b))
        await self.call("adopt", runId=b["run"]["id"], claim="new-lease")
        with self.assertRaises(ReviewError):
            await self.call("compress_finish", **auth, content=self.decision(b))
        raw = self.decision(b)
        done = await self.call("compress_finish", runId=b["run"]["id"], claim="new-lease", content=raw)
        replay = await self.call("compress_finish", runId=b["run"]["id"], claim="new-lease", content=raw)
        self.assertEqual(done["workspace"]["version"], replay["workspace"]["version"])
        self.assertEqual(len(done["workspace"]["messages"]), 12)

    async def test_manual_context_cas_disable_and_lineage(self):
        await self.create()
        await self.chats()
        b = await self.compress()
        done = await self.call("compress_finish", runId=b["run"]["id"], claim="summary-lease", content=self.decision(b))
        args = dict(version=done["workspace"]["version"], baseSummaryVersion=1, text="人工纠正：尚未完成")
        edited = await self.call("context_save", **args)
        with self.assertRaises(ReviewError):
            await self.call("context_save", **args)
        self.assertEqual(edited["workspace"]["context"]["summary"]["source"], "human")
        off = await self.call("context_config", version=edited["workspace"]["version"], enabled=False)
        new = await self.call("begin", version=off["workspace"]["version"], content="继续", clientKey="full", claim="lease", model="fixture", apiFingerprint="a"*64)
        self.assertIn("用户任务0", str(new["run"]["messages"]))
        await self.call("finish", runId=new["run"]["id"], claim="lease", content="继续工作")
        await self.chats(count=2, offset=10)
        again = await self.compress(client="sum-b")
        task = json.loads(again["run"]["messages"][1]["content"])
        self.assertEqual(task["previous"], "人工纠正：尚未完成")
        service = self.s.workspaces
        damaged = service.load("same")
        damaged["messages"][0]["content"] = "模拟原文变更"
        service.save(damaged)
        with self.assertRaises(ReviewError) as error:
            await self.call("compress_finish", runId=again["run"]["id"], claim="summary-lease", content=self.decision(again))
        self.assertEqual(error.exception.code, "work_context_changed")
