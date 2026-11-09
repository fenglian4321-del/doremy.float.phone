"""Explicit offline/opt-in Latent evaluation; never opens the live memory vault."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

from float_latent_semantic import ConfiguredEmbeddingProvider, SemanticError, SemanticCandidateIndex, SEMANTIC_RELEVANCE_POLICY


class CalibrationError(Exception):
    pass


class EvaluationIndex(SemanticCandidateIndex):
    """Reuse raw scores too; keep the upstream hybrid ranking unchanged."""
    def _vector_scores(self, query):
        if query not in self.evaluation_scores:
            self.evaluation_scores[query] = super()._vector_scores(query)
        return self.evaluation_scores[query]


def validate_dataset(value):
    """Labels/queries remain in memory only; reject partial or leaking split labels."""
    def exact(row, keys):
        if not isinstance(row, dict) or set(row) != set(keys):
            raise CalibrationError("校准数据字段无效。")

    def identifier(value):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
            raise CalibrationError("数据 ID 必须是简短、不含私人正文的标识。")

    def text(value):
        if not isinstance(value, str) or not value.strip() or len(value) > 4096 or "\x00" in value:
            raise CalibrationError("样本须为 1–4096 字符完整文本，不截断输入。")

    exact(value, ["version", "memories", "queries"])
    if type(value["version"]) is not int or value["version"] != 1:
        raise CalibrationError("不支持的数据版本。")
    for key in ["memories", "queries"]:
        if not isinstance(value[key], list) or not 1 <= len(value[key]) <= 64:
            raise CalibrationError("每组须有 1–64 条样本。")
    ids, documents = set(), set()
    for row in value["memories"]:
        exact(row, ["id", "content"])
        identifier(row["id"])
        text(row["content"])
        normalized = " ".join(row["content"].split()).casefold()
        if row["id"] in ids or normalized in documents:
            raise CalibrationError("记忆 ID 或正文重复，先清理样本。")
        ids.add(row["id"])
        documents.add(normalized)
    query_ids, queries = set(), set()
    counts = {split: {"positive": 0, "negative": 0} for split in ["calibration", "validation"]}
    for row in value["queries"]:
        exact(row, ["id", "text", "expectedIds", "split"])
        identifier(row["id"])
        text(row["text"])
        normalized = " ".join(row["text"].split()).casefold()
        if row["id"] in query_ids or normalized in queries or normalized in documents:
            raise CalibrationError("查询重复或照抄记忆正文；不能跨组重复调参。")
        if not isinstance(row["split"], str) or row["split"] not in counts:
            raise CalibrationError("必须明确 calibration 或 validation 分组。")
        expected = row["expectedIds"]
        if not isinstance(expected, list) or any(not isinstance(item, str) or item not in ids for item in expected) or len(set(expected)) != len(expected):
            raise CalibrationError("预期命中必须引用本数据集内唯一的记忆 ID。")
        query_ids.add(row["id"])
        queries.add(normalized)
        counts[row["split"]]["positive" if expected else "negative"] += 1
    if any(count < 2 for split in counts.values() for count in split.values()):
        raise CalibrationError("调参组与留出验证组各需至少 2 条有答案和 2 条无答案查询。")
    return counts


def read_dataset(file):
    path = Path(file)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 262144:
        raise CalibrationError("请提供不超过 256 KiB 的普通样本 JSON 文件。")
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise CalibrationError("JSON 有重复字段。")
            value[key] = item
        return value
    try:
        raw = path.read_bytes()
        if len(raw) > 262144:
            raise CalibrationError("样本超过容量。")
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    except (UnicodeError, ValueError):
        raise CalibrationError("样本必须是 UTF-8 JSON。") from None
    validate_dataset(value)
    return value, hashlib.sha256(raw).hexdigest()


def evaluate(index, rows):
    tp = fp = fn = false_answer_queries = 0
    for row in rows:
        # Same full hybrid route and topN=20 as SemanticRecall._query.
        hits = index.retrieve_candidates(row["text"], topN=20)
        actual = {hit["meta"]["canonical_id"] for hit in hits}
        expected = set(row["expectedIds"])
        tp += len(actual & expected)
        fp += len(actual - expected)
        fn += len(expected - actual)
        false_answer_queries += int(not expected and bool(actual))
    return {"truePositive": tp, "falsePositive": fp, "falseNegative": fn,
            "falseAnswerQueries": false_answer_queries, "queries": len(rows),
            "precision": tp / (tp + fp) if tp + fp else None,
            "recall": tp / (tp + fn) if tp + fn else None}


def calibrate(value, env=None, transport=None):
    counts = validate_dataset(value)
    # A temporary zero is solely a sweep baseline, never an active runtime floor.
    settings = dict(os.environ if env is None else env)
    settings["FLOAT_LATENT_EMBED_HIT_FLOOR"] = "0"
    provider = ConfiguredEmbeddingProvider(settings, transport)
    index = EvaluationIndex(embed=True, provider=provider)
    index.evaluation_scores = {}
    started = time.monotonic()
    for row in value["memories"]:
        index.add(row["content"], {"canonical_id": row["id"]})
    if len(index.chunks) > 128 or len(index.chunks) * provider.dimension > 2_000_000:
        raise CalibrationError("校准派生块超过 128 或 200 万向量分量；未发送任何样本。")
    calibration = [row for row in value["queries"] if row["split"] == "calibration"]
    validation = [row for row in value["queries"] if row["split"] == "validation"]
    try:
        with provider.budget(120):
            index.build()
            # Embed queries once, with the real configured query prefix. All
            # 101 evaluations reuse those vectors; never 101 paid queries.
            index.prime_query_vectors([row["text"] for row in value["queries"]])
        sweep = []
        for step in range(101):
            if time.monotonic() - started > 180:
                raise CalibrationError("校准超过总预算，未给出门槛。")
            index.vec_floor = step / 100
            sweep.append({"floor": index.vec_floor, **evaluate(index, calibration)})
        # Tune only calibration. Holdout data cannot select or revise the floor.
        selected = min(sweep, key=lambda row: (row["falsePositive"], -row["recall"], -row["floor"]))
        index.vec_floor = selected["floor"]
        held_out = evaluate(index, validation)
        if time.monotonic() - started > 180:
            raise CalibrationError("校准超过总预算，未给出门槛。")
        supported = 0 < selected["floor"] < 1 and all(metrics["falsePositive"] == 0 and metrics["recall"] >= 0.8 for metrics in [selected, held_out])
        return {"version": 1, "mode": "explicit-sample-evaluation", "activated": False,
                "configurationFingerprint": provider.id, "relevancePolicy": SEMANTIC_RELEVANCE_POLICY, "counts": counts,
                "memories": len(value["memories"]), "chunks": len(index.chunks),
                "embeddingRequests": provider.calls, "embeddedTexts": provider.texts_embedded,
                "gridStep": 0.01, "candidateFloor": selected["floor"],
                "recommendedFloor": selected["floor"] if supported else None,
                "calibration": selected, "validation": held_out,
                "status": "sample_supported" if supported else "needs_review",
                "limits": ["Small supplied sample; not a production quality guarantee.",
                           "All hybrid candidates must pass the same cosine gate as runtime.",
                           "No runtime config, canonical memory or engine choice changed."]}
    finally:
        index.clear_primed_query_vectors()
        index.evaluation_scores.clear()
        provider.cancelled.set()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", help="Explicitly curated sample; no live vault/SQLite input")
    parser.add_argument("--send-to-configured-provider", action="store_true", help="Send this sample to configured embeddings API; may incur charges")
    parser.add_argument("--report", help="Optional new aggregate JSON report; never overwrites a file")
    args = parser.parse_args(argv)
    report_handle = None
    try:
        if args.report:
            # Reserve exclusively before any paid call, including reruns/races.
            report_handle = open(args.report, "x", encoding="utf-8", opener=lambda name, flags: os.open(name, flags, 0o600))
        value, fingerprint = read_dataset(args.dataset)
        counts = validate_dataset(value)
        report = calibrate(value) if args.send_to_configured_provider else {
            "version": 1, "mode": "dry-run", "sent": False, "activated": False,
            "counts": counts, "memories": len(value["memories"]),
            "notice": "Only explicit --send-to-configured-provider sends sample text; no credentials read in dry-run."}
        report["datasetFingerprint"] = fingerprint
        encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        if report_handle:
            report_handle.write(encoded)
        print(encoded, end="")
        return 0
    except CalibrationError as error:
        print(str(error), file=sys.stderr)
    except SemanticError:
        print("Embedding 失败，未给出门槛或更改配置；没有输出服务端正文。", file=sys.stderr)
    except Exception:
        print("校准未完成；检查样本、独立配置和报告路径。未输出凭据或异常正文。", file=sys.stderr)
    finally:
        if report_handle:
            report_handle.close()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
