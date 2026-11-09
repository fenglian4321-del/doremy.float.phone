"""Opt-in semantic provider and disposable Latent index over canonical facts only.

No corpus, vectors, prompts, credentials or accounting bodies are written to disk.
HTTP transport is deliberately separate from the upstream provider, whose default
2000-character slicing and redirect handling are unsuitable for this boundary.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import hashlib
import json
import math
import os
import re
import threading
import time
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from float_latent_vendor import MemoryIndex
from float_latent_vendor.embedding_provider import EmbeddingProvider


class SemanticError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class ConfiguredEmbeddingProvider(EmbeddingProvider):
    kind = "float-configured-http-v1"

    def __init__(self, env=None, transport=None):
        env = os.environ if env is None else env
        self.endpoint = str(env.get("FLOAT_LATENT_EMBED_ENDPOINT") or "").strip()
        parts = urlsplit(self.endpoint)
        local_http = (parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1")
                      and env.get("FLOAT_LATENT_EMBED_ALLOW_LOCAL_HTTP") == "true")
        if (parts.scheme != "https" and not local_http) or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or not parts.path.endswith("/embeddings"):
            raise ValueError("Latent embedding 需要明确的 HTTPS embeddings 地址；不接受凭据、查询参数或跳转。")
        model = env.get("FLOAT_LATENT_EMBED_MODEL") or ""
        key_name = env.get("FLOAT_LATENT_EMBED_API_KEY_ENV") or "FLOAT_LATENT_EMBED_API_KEY"
        if not isinstance(model, str) or not model or len(model) > 160 or re.search(r"[\x00-\x1f]", model) or not re.fullmatch(r"[A-Z][A-Z0-9_]{1,100}", key_name):
            raise ValueError("Latent embedding 模型或 key 变量名无效。")
        # Read only the explicitly selected embedding credential at runtime. It
        # never becomes a provider ID, header log, traceback or browser field.
        self._key = str(env.get(key_name) or "").strip()
        if not self._key or re.search(r"[\x00-\x20\x7f]", self._key):
            raise ValueError("Latent embedding 独立凭据尚未配置。")
        try:
            self.dimension = int(env.get("FLOAT_LATENT_EMBED_DIMENSIONS") or "")
            self.floor = float(env.get("FLOAT_LATENT_EMBED_HIT_FLOOR") or "nan")
        except (ValueError, TypeError):
            raise ValueError("Latent embedding 需要明确的维度和已校准门槛。") from None
        if not 1 <= self.dimension <= 8192 or not math.isfinite(self.floor) or not 0 <= self.floor <= 1:
            raise ValueError("Latent embedding 维度或门槛无效；不能套用其他模型的值。")
        prefix = env.get("FLOAT_LATENT_EMBED_QUERY_PREFIX")
        if prefix is not None and (not isinstance(prefix, str) or len(prefix) > 512 or "\x00" in prefix):
            raise ValueError("Latent embedding 查询前缀无效。")
        revision = str(env.get("FLOAT_LATENT_EMBED_REVISION") or "1")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", revision):
            raise ValueError("Latent embedding 配置版本无效。")
        super().__init__(model, prefix)
        self._identity = hashlib.sha256(json.dumps([self.kind, self.endpoint, model, self.dimension, self.floor, self.query_prefix, revision], ensure_ascii=False).encode()).hexdigest()
        self._transport = transport
        self._deadline = threading.local()
        self.cancelled = threading.Event()

    @property
    def id(self):
        return self._identity

    def hit_floor(self):
        return self.floor

    @contextmanager
    def budget(self, seconds):
        self._deadline.value = time.monotonic() + seconds
        try:
            yield
        finally:
            self._deadline.value = None

    def _remaining(self):
        if self.cancelled.is_set():
            raise SemanticError("embedding_unavailable", "Latent embedding 已停止。")
        deadline = getattr(self._deadline, "value", None)
        remaining = deadline - time.monotonic() if deadline is not None else 8
        if remaining <= 0:
            raise SemanticError("embedding_unavailable", "Latent embedding 超时，未使用旧索引或其他来源。")
        return min(8, remaining)

    def _post(self, payload):
        timeout = self._remaining()
        if self._transport is not None:
            result = self._transport(payload)
            self._remaining()
            return result
        request = Request(self.endpoint, data=json.dumps(payload, ensure_ascii=False).encode(), method="POST",
                          headers={"Content-Type": "application/json", "Authorization": "Bearer " + self._key})
        try:
            with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
                if response.status != 200 or "application/json" not in response.headers.get("Content-Type", "").lower():
                    raise ValueError()
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise ValueError()
                result = json.loads(raw)
            self._remaining()
            return result
        except Exception:
            raise SemanticError("embedding_unavailable", "Latent embedding 服务未成功，未使用旧索引或其他来源。") from None

    def _embed_raw(self, texts):
        if any(not isinstance(text, str) or not text.strip() or len(text) > 12512 for text in texts):
            raise SemanticError("latent_capacity", "Embedding 输入超过容量，未截断正式正文。")
        vectors = []
        for start in range(0, len(texts), 16):
            batch = texts[start:start + 16]
            try:
                self.calls += 1
                result = self._post({"model": self.model, "input": batch})
                rows = result["data"]
                if not isinstance(rows, list) or len(rows) != len(batch):
                    raise ValueError()
                indexes = [row.get("index") for row in rows if isinstance(row, dict)]
                if len(indexes) != len(rows) or any(type(index) is not int for index in indexes) or sorted(indexes) != list(range(len(batch))):
                    raise ValueError()
                for row in sorted(rows, key=lambda row: row["index"]):
                    vector = row.get("embedding")
                    if (not isinstance(vector, list) or len(vector) != self.dimension
                            or any(type(value) not in (int, float) or not math.isfinite(value) for value in vector)
                            or not math.isfinite(sum(value * value for value in vector))
                            or sum(value * value for value in vector) <= 0):
                        raise ValueError()
                    vectors.append(vector)
            except SemanticError:
                raise
            except Exception:
                raise SemanticError("embedding_unavailable", "Embedding 响应数量、顺序或向量无效，未使用零向量或旧索引。") from None
        return vectors


class SemanticRecall:
    """One bounded background build; final selection always rereads canonical IDs."""
    def __init__(self, provider):
        self.provider = provider
        self.index = None
        self.fingerprint = None
        self.generation = 0
        self.job = None
        self.job_fingerprint = None
        self.state = "unstarted"
        self.retry_at = 0
        self.failure_code = "embedding_unavailable"
        self.query_lock = asyncio.Lock()
        self.closed = False

    def stop(self):
        self.closed = True
        self.invalidate()
        self.provider.cancelled.set()
        if self.job and not self.job.done():
            self.job.cancel()

    def invalidate(self):
        self.generation += 1
        self.index = None
        self.fingerprint = None
        self.state = "building" if self.job and not self.job.done() else "outdated"

    def identity(self, values):
        value = [self.provider.id, sorted((row["id"], row["revision"]) for row in values)]
        return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()

    @staticmethod
    def capacity(values):
        if len(values) > 2000 or sum(len(row["content"]) for row in values) > 2_000_000:
            raise SemanticError("latent_capacity", "Latent 正式池超过 2000 条或 200 万字符容量。")

    def _build(self, values):
        with self.provider.budget(120):
            index = MemoryIndex(embed=True, provider=self.provider)
            for row in values:
                index.add(row["content"], {"canonical_id": row["id"], "canonical_revision": row["revision"]})
            if len(index.chunks) > 4000 or len(index.chunks) * self.provider.dimension > 2_000_000:
                raise SemanticError("latent_capacity", "Latent 超过 4000 派生块或 200 万向量分量容量，未截取部分正文。")
            index.build()
            self.provider._remaining()
            return index

    async def _publish(self, values, fingerprint, refresh, generation):
        try:
            index = await asyncio.to_thread(self._build, values)
            current = await refresh()
            if generation != self.generation or self.identity(current) != fingerprint:
                self.state = "outdated"
                return
            self.index, self.fingerprint, self.state = index, fingerprint, "ready"
        except Exception as error:
            self.index = None
            self.fingerprint = None
            self.state = "error"
            self.failure_code = "latent_capacity" if isinstance(error, SemanticError) and error.code == "latent_capacity" else "embedding_unavailable"
            self.retry_at = time.monotonic() + 30

    def _query(self, index, query):
        with self.provider.budget(10):
            return index.retrieve_candidates(query, topN=20)

    async def retrieve(self, query, values, refresh):
        if self.closed:
            raise SemanticError("latent_unavailable", "Latent 语义召回已停止。")
        self.capacity(values)
        if not values:
            self.invalidate()
            return {"entries": [], "limitedSearch": True}
        fingerprint = self.identity(values)
        if self.index is None or self.fingerprint != fingerprint:
            self.index, self.fingerprint = None, None
            if not self.job or self.job.done():
                if self.state == "error" and self.job_fingerprint == fingerprint and time.monotonic() < self.retry_at:
                    raise SemanticError(self.failure_code, "Latent embedding 暂不可用或超过容量，稍后重试；未回退旧索引。")
                self.job_fingerprint = fingerprint
                self.state = "building"
                self.job = asyncio.create_task(self._publish(values, fingerprint, refresh, self.generation))
            try:
                await asyncio.wait_for(asyncio.shield(self.job), timeout=0.05)
            except asyncio.TimeoutError:
                pass
            if self.index is None or self.fingerprint != fingerprint:
                code = self.failure_code if self.state == "error" else "latent_building"
                raise SemanticError(code, "Latent 语义索引尚未就绪；首次或记忆更新后会后台构建，请稍后重试。" if code == "latent_building" else "Latent embedding 构建失败，未使用旧索引或其他来源。")
        index, generation = self.index, self.generation
        if self.query_lock.locked():
            raise SemanticError("latent_busy", "Latent 语义查询繁忙，请稍后重试。")
        try:
            async with self.query_lock:
                hits = await asyncio.to_thread(self._query, index, query)
        except Exception:
            if self.generation == generation and self.index is index:
                self.invalidate()
                self.state = "error"
                self.failure_code = "embedding_unavailable"
                self.job_fingerprint = fingerprint
                self.retry_at = time.monotonic() + 30
            raise SemanticError("embedding_unavailable", "Latent 语义查询失败，未使用旧索引或其他来源。") from None
        if self.closed:
            raise SemanticError("latent_unavailable", "Latent 语义召回已停止。")
        current = await refresh()
        if generation != self.generation or self.identity(current) != fingerprint:
            if self.index is index:
                self.invalidate()
            raise SemanticError("conflict", "正式记忆已变化，旧向量结果已阻止，请重新读取。")
        pool = {row["id"]: row for row in current}
        selected, seen = [], set()
        for hit in hits:
            meta = hit.get("meta", {})
            identifier = meta.get("canonical_id")
            row = pool.get(identifier)
            if row and meta.get("canonical_revision") == row["revision"] and identifier not in seen:
                selected.append(row)
                seen.add(identifier)
        return {"entries": selected, "limitedSearch": True}
