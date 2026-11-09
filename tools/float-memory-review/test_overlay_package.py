from pathlib import Path
import shutil
import tempfile
import unittest
from check_overlay_package import validate, docker_sources, validate_allowlist


class OverlayPackageTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parent
        self.docker = (self.root / "Dockerfile.overlay").read_text(encoding="utf-8")

    def test_actual_docker_inputs_cover_installer_dependencies(self):
        dependencies = validate(self.root, self.docker)
        self.assertTrue({"float_consolidation.py", "float_workspaces.py", "float_latent_vendor"} <= dependencies)

    def test_missing_new_copy_is_detected(self):
        broken = self.docker.replace(" float_consolidation.py", "").replace(" float_workspaces.py", "")
        with self.assertRaisesRegex(RuntimeError, "float_consolidation.py"):
            validate(self.root, broken)

    def test_materialized_docker_copy_package_is_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary)
            for name in docker_sources(self.docker):
                source = self.root / name
                if source.is_dir():
                    shutil.copytree(source, destination / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
                else:
                    shutil.copyfile(source, destination / name)
            validate(destination)
            (destination / "float_workspaces.py").unlink()
            with self.assertRaisesRegex(RuntimeError, "float_workspaces.py"):
                validate(destination)

    def test_archive_allowlist_cannot_omit_installer_input(self):
        required = validate(self.root, self.docker)
        listed = []
        for name in required:
            path = self.root / name
            listed.extend("tools/float-memory-review/" + (name + "/" + p.name if path.is_dir() else name) for p in (path.iterdir() if path.is_dir() else [path]) if p.name != "__pycache__")
        validate_allowlist(self.root, required, listed)
        with self.assertRaisesRegex(RuntimeError, "float_consolidation.py"):
            validate_allowlist(self.root, required, [p for p in listed if not p.endswith("/float_consolidation.py")])


if __name__ == "__main__":
    unittest.main()
