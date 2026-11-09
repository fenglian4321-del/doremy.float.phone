import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import calibrate_semantic as calibration
from test_latent_semantic import configuration


def dataset():
    return {"version": 1, "memories": [
        {"id": "violet", "content": "aaaaaa"},
        {"id": "lemon", "content": "cccccc"}], "queries": [
        {"id": text, "text": text, "split": split, "expectedIds": expected}
        for split, rows in [
            ("calibration", [("bbbbbb", ["violet"]), ("dddddd", ["lemon"]), ("gggggg", []), ("hhhhhh", [])]),
            ("validation", [("eeeeee", ["violet"]), ("ffffff", ["lemon"]), ("iiiiii", []), ("jjjjjj", [])])]
        for text, expected in rows]}


def transport(payload):
    def vector(text):
        if text in ["aaaaaa", "bbbbbb", "eeeeee"]:
            return [1, 0, 0]
        if text in ["cccccc", "dddddd", "ffffff"]:
            return [0, 1, 0]
        return [0, 0, 1]
    return {"data": [{"index": index, "embedding": vector(text)} for index, text in enumerate(payload["input"])]}


class CalibrationTests(unittest.TestCase):
    def test_real_upstream_hybrid_sweep_reuses_vectors_and_keeps_data_out_of_report(self):
        env = configuration(FLOAT_LATENT_EMBED_HIT_FLOOR="")
        original = dict(env)
        calls = []
        def post(payload):
            calls.append(payload)
            return transport(payload)
        result = calibration.calibrate(dataset(), env, post)
        self.assertEqual(env, original)
        self.assertEqual(len(calls), 2)  # documents once, all queries once
        self.assertEqual(result["embeddingRequests"], 2)
        self.assertEqual(result["embeddedTexts"], 10)
        self.assertEqual(result["status"], "sample_supported")
        self.assertEqual(result["recommendedFloor"], 0.99)
        self.assertEqual(result["validation"]["recall"], 1)
        self.assertEqual(result["validation"]["falseAnswerQueries"], 0)
        self.assertFalse(result["activated"])
        encoded = json.dumps(result)
        for private in ["aaaaaa", "bbbbbb", "synthetic-embedding-key", "fixture.invalid", "fixture-model"]:
            self.assertNotIn(private, encoded)

    def test_holdout_failure_never_tunes_its_way_to_a_recommendation(self):
        def changed(payload):
            answer = transport(payload)
            for text, row in zip(payload["input"], answer["data"]):
                if text in ["eeeeee", "ffffff"]:
                    row["embedding"] = [0, 0, 1]
            return answer
        result = calibration.calibrate(dataset(), configuration(), changed)
        self.assertEqual(result["candidateFloor"], 0.99)
        self.assertEqual(result["validation"]["recall"], 0)
        self.assertIsNone(result["recommendedFloor"])
        self.assertEqual(result["status"], "needs_review")

    def test_lexical_false_positive_must_pass_the_runtime_semantic_gate(self):
        value = dataset()
        value["queries"][2]["text"] = "aaaaaa search"
        result = calibration.calibrate(value, configuration(), transport)
        self.assertEqual(result["calibration"]["falsePositive"], 0)
        self.assertEqual(result["recommendedFloor"], 0.99)
        self.assertEqual(result["relevancePolicy"], "all-candidates-cosine-v1")

    def test_explicit_query_prefix_used_once_per_query(self):
        seen = []
        def post(payload):
            seen.extend(payload["input"])
            return transport({**payload, "input": [text.removeprefix("query:") for text in payload["input"]]})
        result = calibration.calibrate(dataset(), configuration(FLOAT_LATENT_EMBED_QUERY_PREFIX="query:"), post)
        self.assertEqual(result["status"], "sample_supported")
        self.assertEqual(seen[:2], ["aaaaaa", "cccccc"])
        self.assertTrue(all(text.startswith("query:") for text in seen[2:]))

    def test_dataset_rejects_leaks_unknown_labels_bad_splits_and_partial_samples(self):
        patches = [lambda value: value["queries"][4].update(text=" BBBBBB "),
                   lambda value: value["queries"][4].update(text="aaaaaa"),
                   lambda value: value["queries"][0].update(expectedIds=["outside"]),
                   lambda value: value["queries"][0].update(expectedIds=["violet", "violet"]),
                   lambda value: value["queries"][0].update(split=[]),
                   lambda value: value["queries"].pop(),
                   lambda value: value["memories"][0].update(content="x" * 4097),
                   lambda value: value.update(vaultPath="/private"),
                   lambda value: value.update(version=True)]
        for mutate in patches:
            value = copy.deepcopy(dataset())
            mutate(value)
            with self.subTest(value=value), self.assertRaises(calibration.CalibrationError):
                calibration.validate_dataset(value)

    def test_dry_run_has_no_provider_or_credential_access_and_report_never_overwrites(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "samples.json"
            source.write_text(json.dumps(dataset()), encoding="utf-8")
            output = io.StringIO()
            with patch.object(calibration, "ConfiguredEmbeddingProvider", side_effect=AssertionError("network forbidden")), contextlib.redirect_stdout(output):
                self.assertEqual(calibration.main([str(source)]), 0)
            self.assertFalse(json.loads(output.getvalue())["sent"])
            report = Path(temp) / "report.json"
            report.write_text("preserve", encoding="utf-8")
            with patch.object(calibration, "calibrate", side_effect=AssertionError("paid call forbidden")), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(calibration.main([str(source), "--report", str(report), "--send-to-configured-provider"]), 1)
            self.assertEqual(report.read_text(), "preserve")
            source.write_text('{"version":1,"version":1}', encoding="utf-8")
            with self.assertRaises(calibration.CalibrationError):
                calibration.read_dataset(source)
            source.write_text("x" * 262145, encoding="utf-8")
            with self.assertRaises(calibration.CalibrationError):
                calibration.read_dataset(source)

    def test_provider_failure_output_is_sanitized_and_never_returns_floor(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "samples.json"
            source.write_text(json.dumps(dataset()), encoding="utf-8")
            output, error = io.StringIO(), io.StringIO()
            with patch.object(calibration, "calibrate", side_effect=RuntimeError("PRIVATE_BODY synthetic-embedding-key")), contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
                self.assertEqual(calibration.main([str(source), "--send-to-configured-provider"]), 1)
            self.assertEqual(output.getvalue(), "")
            self.assertNotIn("PRIVATE_BODY", error.getvalue())
            self.assertNotIn("synthetic-embedding-key", error.getvalue())


if __name__ == "__main__":
    unittest.main()
