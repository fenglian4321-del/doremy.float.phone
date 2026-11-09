"""Offline tests: never download SDKs, accept licenses, or access signing keys."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile

import local_build as build


class LocalBuildTest(unittest.TestCase):
    def test_missing_consent_prevents_network_and_extraction(self):
        with mock.patch.object(build.urllib.request, "urlopen") as network, mock.patch.object(build, "unpack") as extract:
            with self.assertRaises(build.LicenseRequired):
                build.sdk_prepare(Path("unused-sdk-test-root"), None)
            network.assert_not_called()
            extract.assert_not_called()

    def test_invalid_consent_records_are_rejected(self):
        for record in ({}, {"acceptedBy": "agent"}, {"acceptedBy": "human-user", "agreementUrl": "https://example.invalid"}):
            path = mock.Mock()
            path.is_file.return_value = True
            path.read_text.return_value = json.dumps(record)
            with self.subTest(record=record), self.assertRaises(build.LicenseRequired):
                build.consent(path)

    def test_environment_is_not_enumerated_or_signing_secrets_read(self):
        class HostEnvironment:
            def __iter__(self):
                raise AssertionError("must not enumerate host environment")

            def __contains__(self, key):
                if key not in build.HOST_KEYS:
                    raise AssertionError("unexpected host variable access")
                return key == "SystemRoot"

            def __getitem__(self, key):
                if key != "SystemRoot":
                    raise AssertionError("unexpected host variable read")
                return "C:/Windows"

        root = Path("C:/synthetic build fixture")
        env = build.isolated_env(root, {"jdk": "synthetic-jdk"}, "https://example.invalid", HostEnvironment())
        self.assertEqual(env["SystemRoot"], "C:/Windows")
        self.assertEqual(env["JAVA_HOME"], "synthetic-jdk")
        self.assertEqual(env["ANDROID_HOME"], str(root / "sdk"))
        self.assertEqual(env["GRADLE_USER_HOME"], str(root / "gradle-user-home"))
        self.assertNotIn("SHELL_KEYSTORE_FILE", env)
        self.assertNotIn("SHELL_KEYSTORE_PASSWORD", env)
        self.assertIn('"-Duser.home=', env["JAVA_TOOL_OPTIONS"])

    def test_site_rejects_credentials_paths_injection_and_non_https(self):
        for site in ("http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/a", "https://example.invalid?x=1", "https://example.invalid#x", "https://example.invalid:8443", 'https://example.invalid\"', "https://example.invalid;exit"):
            with self.subTest(site=site), self.assertRaises(ValueError):
                build.site_url(site)
        self.assertEqual(build.site_url("https://EXAMPLE.invalid:443/"), "https://example.invalid")

    def test_archive_rejects_traversal_and_symlinks_before_writing(self):
        for name, symlink in (("../escape.txt", False), ("safe/../../escape.txt", False), ("safe\\escape.txt", False), ("link", True)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = root / "input.zip"
                with zipfile.ZipFile(archive, "w") as bundle:
                    bundle.writestr("would-be-written-first.txt", "fixture")
                    item = zipfile.ZipInfo(name)
                    if symlink:
                        item.external_attr = 0o120777 << 16
                    bundle.writestr(item, "fixture")
                if "\\" in name:
                    # ZipInfo normalizes Windows separators while writing;
                    # retain a genuinely malformed wire-format fixture.
                    archive.write_bytes(archive.read_bytes().replace(name.replace("\\", "/").encode(), name.encode()))
                with self.assertRaises(RuntimeError):
                    build.unpack(archive, root / "extracted")
                self.assertFalse((root / "extracted").exists())
                self.assertFalse((root / "escape.txt").exists())

    def test_failed_tool_does_not_report_success(self):
        with mock.patch.object(build.subprocess, "run", return_value=mock.Mock(returncode=7)):
            with self.assertRaisesRegex(RuntimeError, "7"):
                build.run(["synthetic-tool"], {}, Path("."))

    def test_official_style_long_archive_path_extracts(self):
        directory = str(Path(tempfile.gettempdir()).resolve())
        if build.os.name == "nt" and not directory.startswith("\\\\?\\"):
            directory = "\\\\?\\" + directory
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            root = Path(temporary)
            archive = root / "long-path.zip"
            name = "lib/external/" + "/".join(["dependency" * 5] * 4) + "/fixture.jar"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr(name, "synthetic-fixture")
            destination = root / "extracted"
            build.unpack(archive, destination)
            result = destination.resolve() / name
            if build.os.name == "nt" and not str(result).startswith("\\\\?\\"):
                result = Path("\\\\?\\" + str(result))
            self.assertEqual(result.read_text(), "synthetic-fixture")


if __name__ == "__main__":
    unittest.main()
