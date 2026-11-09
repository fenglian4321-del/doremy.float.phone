import io
from contextlib import closing
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest

from review_service import ReviewService
from test_review_service import Manager
from vault_backup import backup, inspect_archive, member_name, restore


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.vault = self.root / "vault"
        self.vault.mkdir()
        self.service = ReviewService(Manager(), self.vault)
        (self.vault / "dynamic" / "domain").mkdir(parents=True)
        (self.vault / "dynamic" / "domain" / "one.md").write_text("---\nid: one\n---\n虚构原文\n", encoding="utf-8")
        (self.vault / "archive").mkdir()
        (self.vault / "archive" / "two.md").write_text("---\nid: two\ndeleted_at: synthetic\n---\n虚构回收站正文", encoding="utf-8")
        (self.vault / ".env").write_text("SYNTHETIC_SECRET_MUST_NOT_BE_EXPORTED", encoding="utf-8")

    def tearDown(self):
        if self.service:
            self.service.close()
        self.temp.cleanup()

    def test_backup_refuses_live_owner_then_restores_exact_bytes_and_audit(self):
        archive = self.root / "backup.tar.gz"
        with self.assertRaisesRegex(ValueError, "Stop"):
            backup(self.vault, archive)
        self.service.db.execute("UPDATE policy SET paused=1,version=7")
        self.service.close(); self.service = None
        manifest = backup(self.vault, archive)
        self.assertEqual(len(manifest["files"]), 3)
        self.assertNotIn(".env", {item["path"] for item in manifest["files"]})
        destination = self.root / "restored"
        restore(archive, destination)
        self.assertEqual((destination / "dynamic/domain/one.md").read_bytes(), (self.vault / "dynamic/domain/one.md").read_bytes())
        self.assertEqual((destination / "archive/two.md").read_bytes(), (self.vault / "archive/two.md").read_bytes())
        with closing(sqlite3.connect(destination / ".float-review/review.sqlite3")) as connection:
            self.assertEqual(connection.execute("SELECT paused,version FROM policy").fetchone(), (1, 7))
        with self.assertRaisesRegex(ValueError, "nonexistent"):
            restore(archive, self.vault)
        with self.assertRaisesRegex(ValueError, "new backup"):
            backup(self.vault, archive)

    def test_unsafe_members_symlinks_and_tampering_are_rejected_before_restore(self):
        for path in ("../escape.md", "/root.md", "C:/secret.md", "a/../x.md", "a\\x.md", ".env", "CON.md", "a./x.md"):
            with self.assertRaises(ValueError):
                member_name(path)
        archive = self.root / "unsafe.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            link = tarfile.TarInfo("x.md"); link.type = tarfile.SYMTYPE; link.linkname = "/etc/passwd"; bundle.addfile(link)
        with self.assertRaises(ValueError):
            inspect_archive(archive)
        self.service.close(); self.service = None
        good = self.root / "good.tar.gz"; backup(self.vault, good)
        bad = self.root / "bad.tar.gz"
        with tarfile.open(good, "r:gz") as source, tarfile.open(bad, "w:gz") as target:
            for item in source:
                data = source.extractfile(item).read()
                if item.name.endswith("one.md"):
                    data = b"tampered"; item.size = len(data)
                target.addfile(item, io.BytesIO(data))
        destination = self.root / "must-not-exist"
        with self.assertRaises(ValueError):
            restore(bad, destination)
        self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
