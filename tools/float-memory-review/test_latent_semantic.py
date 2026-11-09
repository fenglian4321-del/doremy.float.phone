import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import tempfile
import threading
import unittest

from float_latent_semantic import ConfiguredEmbeddingProvider, SemanticError, SemanticRecall
from float_latent_vendor import MemoryIndex
from review_service import ReviewError, ReviewService
from test_review_service import Manager


def configuration(**patch):
    return {"FLOAT_LATENT_EMBED_ENDPOINT": "https://fixture.invalid/v1/embeddings", "FLOAT_LATENT_EMBED_MODEL": "fixture-model",
            "FLOAT_LATENT_EMBED_API_KEY_ENV": "SYNTHETIC_EMBED_KEY", "SYNTHETIC_EMBED_KEY": "synthetic-embedding-key",
            "FLOAT_LATENT_EMBED_DIMENSIONS": "3", "FLOAT_LATENT_EMBED_HIT_FLOOR": "0.7", **patch}


class ProviderTests(unittest.TestCase):
    def test_fail_closed_configuration_and_identity(self):
        for patch in ({"FLOAT_LATENT_EMBED_ENDPOINT": "http://public.invalid/v1/embeddings"},
                      {"FLOAT_LATENT_EMBED_ENDPOINT": "https://user:secret@fixture.invalid/v1/embeddings"},
                      {"FLOAT_LATENT_EMBED_ENDPOINT": "https://fixture.invalid/v1/embeddings?key=x"},
                      {"FLOAT_LATENT_EMBED_HIT_FLOOR": ""}, {"FLOAT_LATENT_EMBED_HIT_FLOOR": "nan"},
                      {"FLOAT_LATENT_EMBED_DIMENSIONS": "0"}, {"SYNTHETIC_EMBED_KEY": ""}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                ConfiguredEmbeddingProvider(configuration(**patch))
        original = ConfiguredEmbeddingProvider(configuration())
        self.assertNotIn("synthetic-embedding-key", original.id)
        for patch in ({"FLOAT_LATENT_EMBED_MODEL": "different-model"}, {"FLOAT_LATENT_EMBED_ENDPOINT": "https://fixture.invalid/other/embeddings"}, {"FLOAT_LATENT_EMBED_REVISION": "2"}, {"FLOAT_LATENT_EMBED_DIMENSIONS": "4"}, {"FLOAT_LATENT_EMBED_QUERY_PREFIX": "查询："}):
            self.assertNotEqual(original.id, ConfiguredEmbeddingProvider(configuration(**patch)).id)

    def test_full_text_batches_response_order_and_no_truncation(self):
        seen = []
        def post(payload):
            seen.extend(payload["input"])
            return {"data": [{"index": index, "embedding": [1, 0, 0]} for index in reversed(range(len(payload["input"])))]}
        provider = ConfiguredEmbeddingProvider(configuration(), post)
        texts = ["完整正文" * 1000] + [f"条目{index}" for index in range(16)]
        self.assertEqual(len(provider.embed(texts)), 17)
        self.assertEqual(seen, texts)
        self.assertEqual(provider.calls, 2)

    def test_bad_vectors_and_service_errors_never_become_zero_vectors(self):
        bad = [{"data": []}, {"data": [{"index": 0, "embedding": [1, 0]}]},
               {"data": [{"index": 0, "embedding": [0, 0, 0]}]},
               {"data": [{"index": 0, "embedding": [float("nan"), 0, 1]}]},
               {"data": [{"index": True, "embedding": [1, 0, 0]}]},
               {"data": [{"index": 0, "embedding": [True, 0, 0]}]}]
        for response in bad:
            with self.subTest(response=response), self.assertRaises(SemanticError):
                ConfiguredEmbeddingProvider(configuration(), lambda _: response).embed(["虚构的正文"])
        def failing(_):
            raise RuntimeError("synthetic-embedding-key PRIVATE_BODY")
        with self.assertRaises(SemanticError) as raised:
            ConfiguredEmbeddingProvider(configuration(), failing).embed(["PRIVATE_BODY"])
        self.assertNotIn("PRIVATE_BODY", str(raised.exception))
        self.assertNotIn("synthetic-embedding-key", str(raised.exception))

    def test_http_redirect_does_not_forward_credential(self):
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append(self.path)
                self.send_response(500)
                self.end_headers()
            def do_POST(self):
                calls.append(self.path)
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(302)
                self.send_header("Location", "/untrusted/embeddings")
                self.end_headers()
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            env = configuration(FLOAT_LATENT_EMBED_ENDPOINT=f"http://127.0.0.1:{server.server_port}/v1/embeddings", FLOAT_LATENT_EMBED_ALLOW_LOCAL_HTTP="true")
            with self.assertRaises(SemanticError):
                ConfiguredEmbeddingProvider(env).embed(["虚构的正文"])
            self.assertEqual(calls, ["/v1/embeddings"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class SemanticRecallTests(unittest.IsolatedAsyncioTestCase):
    query = "吃东西有什么忌口"
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = Manager()
        self.service = ReviewService(self.manager, self.temp.name)
        self.inputs = []
        self.failing = False
        self.block_queries = False
        self.block_documents = False
        self.entered = threading.Event()
        self.release = threading.Event()
        self.provider = ConfiguredEmbeddingProvider(configuration(), self.transport)
        self.service.latent_factory = MemoryIndex
        self.service.latent_mode = "semantic-hybrid-v1"
        self.service.latent_semantic = SemanticRecall(self.provider)

    def tearDown(self):
        self.release.set()
        self.service.close()
        self.temp.cleanup()

    def transport(self, payload):
        self.inputs.extend(payload["input"])
        if self.failing:
            raise RuntimeError("synthetic-embedding-key PRIVATE_BODY")
        if ((self.block_queries and self.query in payload["input"])
                or (self.block_documents and self.query not in payload["input"])):
            self.entered.set()
            self.release.wait(2)
        def vector(text):
            if text == self.query or ("过敏" in text and "没有" not in text):
                return [1, 0, 0]
            return [0, 1, 0] if "薄荷" in text or "没有" in text else [0, 0, 1]
        return {"data": [{"index": index, "embedding": vector(text)} for index, text in enumerate(payload["input"])]}

    async def add(self, content, key):
        return (await self.service.record({"clientKey": key, "kind": "create", "content": content}, manual=True))["targetId"]

    async def ready(self, query=None):
        query = self.query if query is None else query
        try:
            return await self.service.memories(query, "latent")
        except ReviewError as error:
            if error.code != "latent_building":
                raise
            await asyncio.wait_for(asyncio.shield(self.service.latent_semantic.job), 2)
            return await self.service.memories(query, "latent")

    async def test_real_vector_route_finds_paraphrase_without_lexical_overlap(self):
        target = await self.add("她对花生严重过敏。", "allergy")
        await self.add("他养了一盆薄荷。", "mint")
        selected = await self.ready()
        self.assertEqual([row["id"] for row in selected["entries"]], [target])
        self.assertTrue(self.service.latent_semantic.index.embed)
        self.assertEqual(self.service.latent_semantic.index.vec_floor, 0.7)
        self.assertEqual((await self.ready("火星天气如何"))["entries"], [])
        self.assertIn(self.query, self.inputs)
        self.assertFalse(any(path.suffix in (".json", ".vec") for path in __import__("pathlib").Path(self.temp.name).rglob("*")))

    async def test_correction_archive_delete_and_external_edit_invalidate_vectors(self):
        target = await self.add("她对花生严重过敏。", "allergy")
        await self.ready()
        old = self.service.latent_semantic.index
        await self.manager.touch_many([target])
        self.assertIs(self.service.latent_semantic.index, old)
        await self.manager.update(target, content="她没有花生过敏，旧记录已纠正。")
        self.assertIsNone(self.service.latent_semantic.index)
        self.assertEqual((await self.ready())["entries"], [])
        # Simulate a native file editor bypassing the coordinated manager.
        self.manager.entries[target]["content"] = "她对花生严重过敏。"
        self.assertEqual((await self.ready())["entries"][0]["id"], target)
        await self.manager.update(target, type="archived", dont_surface=True)
        self.assertEqual((await self.ready())["entries"], [])
        await self.manager.update(target, type="dynamic", dont_surface=False)
        self.assertEqual((await self.ready())["entries"][0]["id"], target)
        await self.manager.delete(target)
        self.assertEqual((await self.ready())["entries"], [])

    async def test_build_does_not_lock_writes_or_publish_pre_correction_pool(self):
        target = await self.add("她对花生严重过敏。", "allergy")
        self.block_documents = True
        with self.assertRaises(ReviewError) as raised:
            await self.service.memories(self.query, "latent")
        self.assertEqual(raised.exception.code, "latent_building")
        self.assertTrue(self.entered.is_set())
        await asyncio.wait_for(self.manager.update(target, content="她没有花生过敏，旧记录已纠正。"), 0.2)
        self.block_documents = False
        self.release.set()
        await asyncio.wait_for(asyncio.shield(self.service.latent_semantic.job), 2)
        self.assertIsNone(self.service.latent_semantic.index)
        self.assertEqual((await self.ready())["entries"], [])

    async def test_query_rechecks_entire_pool_after_embedding_network_yield(self):
        target = await self.add("她对花生严重过敏。", "allergy")
        await self.ready()
        self.block_queries = True
        pending = asyncio.create_task(self.service.memories(self.query, "latent"))
        self.assertTrue(await asyncio.to_thread(self.entered.wait, 1))
        await asyncio.wait_for(self.manager.update(target, content="她没有花生过敏，旧记录已纠正。"), 0.2)
        self.release.set()
        with self.assertRaises(ReviewError) as raised:
            await pending
        self.assertEqual(raised.exception.code, "conflict")
        self.block_queries = False
        self.assertEqual((await self.ready())["entries"], [])

    async def test_failure_cooldown_and_provider_change_do_not_reuse_vectors(self):
        await self.add("她对花生严重过敏。", "allergy")
        await self.ready()
        self.failing = True
        with self.assertRaises(ReviewError) as raised:
            await self.service.memories(self.query, "latent")
        self.assertEqual(raised.exception.code, "embedding_unavailable")
        count = len(self.inputs)
        with self.assertRaises(ReviewError):
            await self.service.memories(self.query, "latent")
        self.assertEqual(len(self.inputs), count, "Failure cooldown avoids another paid build")
        self.failing = False
        self.service.latent_semantic.provider = ConfiguredEmbeddingProvider(configuration(FLOAT_LATENT_EMBED_REVISION="2"), self.transport)
        self.assertEqual(len((await self.ready())["entries"]), 1)

    async def test_hidden_and_optional_review_proposals_are_not_embedded(self):
        hidden = await self.add("隐藏的过敏事实。", "hidden")
        await self.manager.update(hidden, dont_surface=True)
        await self.service.set_policy(False, 1, True)
        # The public API uses policy versions; test native policy here without a model.
        await self.service.record({"clientKey": "draft", "kind": "create", "content": "尚未确认的过敏提案。"})
        self.assertEqual((await self.ready())["entries"], [])
        self.assertEqual(self.inputs, [])

    async def test_vector_capacity_is_checked_before_paid_embedding(self):
        provider = ConfiguredEmbeddingProvider(configuration(FLOAT_LATENT_EMBED_DIMENSIONS="8192"), self.transport)
        recall = SemanticRecall(provider)
        rows = [{"id": f"synthetic-{index}", "revision": "a" * 64, "content": f"虚构事实编号{index}。"} for index in range(300)]
        with self.assertRaises(SemanticError) as raised:
            recall._build(rows)
        self.assertEqual(raised.exception.code, "latent_capacity")
        self.assertEqual(self.inputs, [], "Reject excessive dimensions times chunks before provider calls")


if __name__ == "__main__":
    unittest.main()
