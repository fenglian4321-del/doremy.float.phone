"""External position pinning. No actual MCP/device/provider calls."""
import copy
import tempfile
import unittest
from review_service import ReviewService, ReviewError
from test_review_service import Manager


class ExternalSpaceRunTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.manager = Manager()
        self.original = copy.deepcopy(self.manager.entries)
        self.service = ReviewService(self.manager, self.temporary.name)

    def tearDown(self):
        self.assertEqual(self.manager.entries, self.original)
        self.assertEqual(self.service.db.execute("SELECT COUNT(*) FROM candidates").fetchone()[0], 0)
        self.service.close()
        self.temporary.cleanup()

    async def start(self, mode="work", external="mcp"):
        space = self.service.workspaces if mode == "work" else self.service.private_spaces
        key = mode + "-" + external
        state = await space.dispatch(dict(operation="create", title="合成外部任务", clientKey=key))
        body = dict(operation="begin", workspaceId=key, clientKey=key+"-request", claim="synthetic-claim", version=state["workspace"]["version"], content="只处理此空间的明确任务", model="synthetic", apiFingerprint="f"*64, externalMode=external)
        return space, key, body

    async def test_modes_require_capability_and_pin_prompt_without_life(self):
        for mode in ("work", "private"):
            for external in ("phone", "mcp"):
                space, key, body = await self.start(mode, external)
                with self.assertRaises(ReviewError) as error:
                    await space.dispatch(body)
                self.assertEqual(error.exception.code, "work_client_upgrade")
                detail = await space.dispatch(dict(operation="detail", workspaceId=key))
                self.assertEqual(detail["workspace"]["messages"], [])
                result = await space.dispatch(dict(body, _externalClient="v1"))
                self.assertEqual(result["run"]["externalMode"], external)
                self.assertIn("VPS文件工具暂停", result["run"]["messages"][0]["content"])
                self.assertIn("不可信资料", result["run"]["messages"][0]["content"])

    async def test_old_clients_cannot_read_resume_or_finish_external_run(self):
        for mode in ("work", "private"):
            space, key, body = await self.start(mode)
            result = await space.dispatch(dict(body, _externalClient="v1"))
            run_id = result["run"]["id"]
            operations = [dict(operation="detail", workspaceId=key), dict(operation="lookup", workspaceId=key, clientKey=body["clientKey"], claim=body["claim"])]
            for operation in ("adopt", "heartbeat", "cancel", "close", "resume", "turn", "tool", "finish"):
                operations.append(dict(operation=operation, workspaceId=key, runId=run_id, claim=body["claim"]))
            for request in operations:
                with self.subTest(mode=mode, operation=request["operation"]), self.assertRaises(ReviewError) as error:
                    await space.dispatch(request)
                self.assertEqual(error.exception.code, "work_client_upgrade")
            current = await space.dispatch(dict(operation="detail", workspaceId=key, _externalClient="v1"))
            self.assertEqual(current["run"]["state"], "running")
            self.assertEqual(current["run"]["turn"], 0)

    async def test_new_clients_cannot_switch_external_to_vps_tools(self):
        for mode in ("work", "private"):
            for external in ("phone", "mcp"):
                space, key, body = await self.start(mode, external)
                result = await space.dispatch(dict(body, _externalClient="v1"))
                identity = dict(workspaceId=key, runId=result["run"]["id"], claim=body["claim"], _externalClient="v1")
                for operation in ("turn", "tool", "compress_finish"):
                    with self.assertRaises(ReviewError) as error:
                        await space.dispatch(dict(identity, operation=operation))
                    self.assertEqual(error.exception.code, "work_tool_forbidden")
                done = await space.dispatch(dict(identity, operation="finish", content="根据本区回执说明的最终回复"))
                self.assertEqual(done["run"]["state"], "complete")
                self.assertEqual(done["workspace"]["files"], [])

    async def test_request_key_cannot_change_position_and_restart_retains_pin(self):
        space, key, body = await self.start()
        created = await space.dispatch(dict(body, _externalClient="v1"))
        for external in (None, "phone"):
            changed = dict(body, _externalClient="v1")
            if external:
                changed["externalMode"] = external
            else:
                changed.pop("externalMode")
            with self.assertRaises(ReviewError):
                await space.dispatch(changed)
        self.service.close()
        self.service = ReviewService(self.manager, self.temporary.name)
        with self.assertRaises(ReviewError):
            await self.service.workspaces.dispatch(dict(operation="detail", workspaceId=key))
        same = await self.service.workspaces.dispatch(dict(operation="detail", workspaceId=key, _externalClient="v1"))
        self.assertEqual(same["run"]["id"], created["run"]["id"])
        self.assertEqual(same["run"]["externalMode"], "mcp")

    async def test_unpinned_legacy_task_is_readable_but_cannot_resume_actions(self):
        for mode in ("work", "private"):
            space, key, body = await self.start(mode)
            body.pop("externalMode")
            with self.assertRaises(ReviewError) as error:
                await space.dispatch(body)
            self.assertEqual(error.exception.code, "work_client_upgrade")
            result = await space.dispatch(dict(body, _externalClient="v1"))
            self.assertEqual(result["run"]["executionVersion"], 1)
            run = space.get_run(space.load(key), result["run"]["id"])
            run.pop("executionVersion")  # exact pre-upgrade persisted shape
            space.save(space.load(key), run)
            for capability in (None, "v1"):
                for operation in ("heartbeat", "resume", "turn", "tool", "finish"):
                    request = dict(operation=operation, workspaceId=key, runId=run["id"], claim=body["claim"])
                    if capability:
                        request["_externalClient"] = capability
                    with self.subTest(mode=mode, operation=operation, client=capability), self.assertRaises(ReviewError) as error:
                        await space.dispatch(request)
                    self.assertEqual(error.exception.code, "work_client_upgrade")
            current = await space.dispatch(dict(operation="detail", workspaceId=key, _externalClient="v1"))
            self.assertNotIn("executionVersion", current["run"])
            self.assertEqual(len(current["workspace"]["messages"]), 1)
            closed = await space.dispatch(dict(operation="close", workspaceId=key, runId=run["id"], claim=body["claim"], _externalClient="v1"))
            self.assertIsNone(closed["workspace"]["activeRun"])
            self.assertEqual(closed["workspace"]["files"], [])

    async def test_assistant_files_require_live_pinned_claim_and_preserve_receipts(self):
        for mode in ("work", "private"):
            space, key, body = await self.start(mode, "assistant")
            begun = await space.dispatch(dict(body, _externalClient="v1"))
            self.assertEqual(begun["run"]["externalMode"], "assistant")
            self.assertIn("任务助手会话", begun["run"]["messages"][0]["content"])
            identity = dict(workspaceId=key, runId=begun["run"]["id"], claim=body["claim"], _externalClient="v1")
            prefix = "workspace_" if mode == "work" else "private_"
            request = dict(identity, operation="assistant_file", callId="write-one", name=prefix+"write_file", args=dict(path="notes/task.md", content="合成任务文件", baseVersion=0))
            first = await space.dispatch(request)
            repeated = await space.dispatch(request)
            self.assertEqual(first["result"]["version"], repeated["result"]["version"])
            self.assertEqual(first["result"]["version"], 1)
            changed = dict(request, args=dict(request["args"], content="不能替换原动作"))
            with self.assertRaises(ReviewError) as error:
                await space.dispatch(changed)
            self.assertEqual(error.exception.code, "work_conflict")
            for bad in (dict(request, claim="other-device"), dict(request, name="life_write", callId="bad")):
                with self.assertRaises(ReviewError):
                    await space.dispatch(bad)
            readonly = await space.dispatch(dict(identity, operation="assistant_file", callId="read-one", name=prefix+"read_file", args=dict(path="notes/task.md")))
            self.assertEqual(readonly["result"]["content"], "合成任务文件")
            await space.dispatch(dict(identity, operation="cancel"))
            with self.assertRaises(ReviewError):
                await space.dispatch(dict(request, callId="after-stop"))
            state = await space.dispatch(dict(operation="detail", workspaceId=key, _externalClient="v1"))
            self.assertEqual(state["workspace"]["files"][0]["version"], 1)

    async def test_assistant_file_operation_is_not_an_escape_for_other_modes(self):
        for external in ("phone", "mcp"):
            space, key, body = await self.start("work", external)
            begun = await space.dispatch(dict(body, _externalClient="v1"))
            with self.assertRaises(ReviewError):
                await space.dispatch(dict(operation="assistant_file", workspaceId=key, runId=begun["run"]["id"], claim=body["claim"], _externalClient="v1", callId="escape", name="workspace_write_file", args=dict(path="x.md",content="不可写",baseVersion=0)))


if __name__ == "__main__":
    unittest.main()
