import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from float_provider_state import install_runtime, private_path, read_values, start


class ProviderStateTests(unittest.TestCase):
    def test_start_preserves_original_entrypoint_and_yaml_model_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".float-model.env"
            path.write_text("OMBRE_EMBED_API_KEY=synthetic-new-key\nUNSUPPORTED=not-loaded\n", encoding="utf-8")
            with patch.dict(os.environ, {"FLOAT_MODEL_ENV_PATH": "/app/buckets/.float-model.env", "OMBRE_EMBED_API_KEY": "synthetic-old-key", "OMBRE_COMPRESS_MODEL": "stale-model", "OMBRE_EMBED_MODEL": "stale-model"}, clear=True), patch("float_provider_state.private_path", return_value=path), patch("float_provider_state.os.execv") as execute, patch.object(sys, "argv", ["float_provider_state.py", "synthetic-cmd"]):
                start()
                self.assertEqual(os.environ["OMBRE_EMBED_API_KEY"], "synthetic-new-key")
                self.assertEqual(os.environ["OMBRE_COMPRESS_API_KEY"], "")
                self.assertNotIn("OMBRE_EMBED_MODEL", os.environ)
                self.assertNotIn("OMBRE_COMPRESS_MODEL", os.environ)
                self.assertNotIn("UNSUPPORTED", os.environ)
                execute.assert_called_once_with("/app/entrypoint.sh", ["/app/entrypoint.sh", "synthetic-cmd"])

    def test_data_only_fixed_keys_and_invalid_syntax(self):
        with tempfile.TemporaryDirectory() as directory:
            path = private_path(str(Path(directory) / ".float-model.env"), directory)
            path.write_text("UNKNOWN=$(do-not-run)\nOMBRE_EMBED_API_KEY='$(still-data)'\nOMBRE_COMPRESS_BASE_URL=https://fixture.invalid/v1\nOMBRE_EMBED_MODEL=not-an-env-override\n", encoding="utf-8")
            self.assertEqual(read_values(path), {"OMBRE_EMBED_API_KEY": "$(still-data)", "OMBRE_COMPRESS_BASE_URL": "https://fixture.invalid/v1"})
            path.write_text("OMBRE_EMBED_API_KEY='SYNTHETIC_SECRET_WITH_UNCLOSED_QUOTE", encoding="utf-8")
            with self.assertRaises(RuntimeError) as raised:
                read_values(path)
            self.assertNotIn("SYNTHETIC_SECRET", str(raised.exception))

    def test_path_must_stay_inside_private_vault(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                private_path(str(Path(directory).parent / "outside-provider.env"), directory)
            with self.assertRaises(RuntimeError):
                private_path("relative-provider.env", directory)

    def test_native_dashboard_writer_mapping_is_idempotent_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".float-model.env"
            native = types.ModuleType("web._shared")
            native._project_env_path = lambda: "unused"
            native._write_env_var = lambda name, value: Path(native._project_env_path()).write_text(f"{name}={value}\n", encoding="utf-8")
            web = types.ModuleType("web")
            web._shared = native
            with patch.dict(sys.modules, {"web": web, "web._shared": native}), patch.dict(os.environ, {"FLOAT_MODEL_ENV_PATH": str(path)}, clear=True), patch("float_provider_state.os.chmod", wraps=os.chmod) as chmod:
                install_runtime(directory)
                writer = native._write_env_var
                install_runtime(directory)
                self.assertIs(native._write_env_var, writer)
                native._write_env_var("OMBRE_EMBED_API_KEY", "synthetic-key-only")
                self.assertEqual(read_values(path)["OMBRE_EMBED_API_KEY"], "synthetic-key-only")
                self.assertEqual(chmod.call_args.args[1], 0o600)
                if os.name != "nt":
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(RuntimeError):
                    native._write_env_var("OMBRE_EMBED_API_KEY", "injected\nUNKNOWN=value")


if __name__ == "__main__":
    unittest.main()
