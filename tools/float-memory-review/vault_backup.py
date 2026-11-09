"""Offline backup/restore of canonical Markdown + Float audit state.

Run with the single review-enabled Ombre process stopped. Derived indexes,
application settings, model keys and chats are deliberately outside this format.
Restore verifies all bytes before writing, and only writes into a new directory.
"""
from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import io
import json
import os
import re
from pathlib import Path, PurePosixPath
import sqlite3
import tarfile
import tempfile

SCHEMA = "float-memory-backup/v1"
MAX_FILES, MAX_TOTAL = 20_000, 512 * 1024 * 1024
DB_NAME = ".float-review/review.sqlite3"


def member_name(value):
    if not isinstance(value, str) or re.search(r'[\\:\x00-\x1f<>"|?*]', value):
        raise ValueError("Unsafe backup path")
    path = PurePosixPath(value)
    if path.is_absolute() or not value or str(path) != value or any(part in (".", "..", "") for part in value.split("/")):
        raise ValueError("Unsafe backup path")
    if any(part.endswith((".", " ")) or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part, re.I) for part in path.parts):
        raise ValueError("Nonportable backup path")
    if value != DB_NAME and (not value.endswith(".md") or any(part.startswith(".") for part in path.parts)):
        raise ValueError("Unsupported backup member")
    return value


def digest(stream):
    hasher = hashlib.sha256()
    while chunk := stream.read(65536):
        hasher.update(chunk)
    return hasher.hexdigest()


@contextmanager
def offline_lock(vault):
    directory = vault / ".float-review"
    if directory.is_symlink() or not directory.is_dir() or (directory / "writer.lock").is_symlink():
        raise ValueError("Expected a review-enabled vault without symlinked state")
    stream = open(directory / "writer.lock", "a+b")
    try:
        try:
            if os.name == "nt":
                import msvcrt
                stream.seek(0); stream.write(b"0"); stream.flush(); stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ValueError("Stop the review-enabled Ombre process before backup") from None
        yield
    finally:
        stream.close()


def inspect_archive(archive):
    with tarfile.open(archive, "r:gz") as bundle:
        members, total = [], 0
        for item in bundle:
            members.append(item); total += item.size
            if len(members) > MAX_FILES + 1 or total > MAX_TOTAL:
                raise ValueError("Backup exceeds supported size")
        if any(not item.isfile() for item in members) or len({item.name for item in members}) != len(members):
            raise ValueError("Links, directories and duplicate members are not accepted")
        manifest_member = next((item for item in members if item.name == "manifest.json"), None)
        if not manifest_member or manifest_member.size > 8 * 1024 * 1024:
            raise ValueError("Missing or oversized backup manifest")
        manifest = json.load(bundle.extractfile(manifest_member))
        if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA or not isinstance(manifest.get("files"), list) or len(manifest["files"]) > MAX_FILES:
            raise ValueError("Unknown backup schema")
        expected = {}
        for item in manifest["files"]:
            if not isinstance(item, dict):
                raise ValueError("Invalid backup manifest entry")
            name = member_name(item.get("path"))
            if name in expected or type(item.get("size")) is not int or not 0 <= item["size"] <= MAX_TOTAL or not isinstance(item.get("sha256"), str) or len(item["sha256"]) != 64:
                raise ValueError("Invalid backup manifest entry")
            expected[name] = item
        if DB_NAME not in expected or set(expected) != {item.name for item in members if item.name != "manifest.json"}:
            raise ValueError("Manifest/member mismatch")
        for item in members:
            if item.name == "manifest.json":
                continue
            name = member_name(item.name)
            if item.size != expected[name]["size"] or digest(bundle.extractfile(item)) != expected[name]["sha256"]:
                raise ValueError("Backup checksum mismatch")
        return manifest


def backup(vault, destination):
    vault = Path(vault).resolve(strict=True)
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink() or destination.resolve().is_relative_to(vault):
        raise ValueError("Choose a new backup file outside the vault")
    with offline_lock(vault), tempfile.TemporaryDirectory(prefix=".float-vault-backup-", dir=destination.parent) as temporary:
        database = vault / DB_NAME
        if database.is_symlink() or not database.is_file():
            raise ValueError("Missing canonical Float audit database")
        snapshot_db = Path(temporary) / "review.sqlite3"
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as source, closing(sqlite3.connect(snapshot_db)) as target:
            source.backup(target)
        files = []
        for path in sorted(vault.rglob("*")):
            if path.is_symlink():
                raise ValueError("Symlinks are not accepted in a canonical backup")
            if not path.is_file() or path.suffix != ".md" or any(part.startswith(".") for part in path.relative_to(vault).parts):
                continue
            files.append((member_name(path.relative_to(vault).as_posix()), path))
        files.append((DB_NAME, snapshot_db))
        if len(files) > MAX_FILES or sum(path.stat().st_size for _, path in files) > MAX_TOTAL:
            raise ValueError("Vault exceeds supported backup size")
        manifest = {"schema": SCHEMA, "createdAt": datetime.now(timezone.utc).isoformat(), "scope": "canonical-markdown-and-float-review", "files": []}
        states = {}
        for name, path in files:
            stat = path.stat()
            states[name] = (stat.st_size, stat.st_mtime_ns)
            with path.open("rb") as stream:
                manifest["files"].append({"path": name, "size": stat.st_size, "sha256": digest(stream)})
        # Create exclusively, with private permissions. Failure leaves an obvious
        # partial file for inspection instead of silently overwriting a backup.
        descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "wb") as output, tarfile.open(fileobj=output, mode="w:gz") as bundle:
            for name, path in files:
                info = tarfile.TarInfo(name); info.size = path.stat().st_size; info.mode = 0o600
                with path.open("rb") as stream:
                    bundle.addfile(info, stream)
            body = json.dumps(manifest, ensure_ascii=False, sort_keys=True).encode()
            info = tarfile.TarInfo("manifest.json"); info.size = len(body); info.mode = 0o600
            bundle.addfile(info, io.BytesIO(body))
        current_names = {path.relative_to(vault).as_posix() for path in vault.rglob("*.md") if path.is_file() and not any(part.startswith(".") for part in path.relative_to(vault).parts)}
        if current_names != {name for name, _ in files if name != DB_NAME} or any((path.stat().st_size, path.stat().st_mtime_ns) != states[name] for name, path in files):
            raise ValueError("Vault changed during backup; do not use the partial archive")
        inspect_archive(destination)
        return manifest


def restore(archive, destination):
    archive = Path(archive).resolve(strict=True)
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError("Restore only accepts a new, nonexistent destination directory")
    # Reject symlinked parents, including paths that would resolve outside the
    # explicitly named destination. Never delete/move/replace a current vault.
    if any(parent.is_symlink() for parent in destination.parents):
        raise ValueError("Symlinked restore parent is not accepted")
    manifest = inspect_archive(archive)
    expected = {item["path"]: item for item in manifest["files"]}
    destination.mkdir(mode=0o700, parents=False)
    with tarfile.open(archive, "r:gz") as bundle:
        for item in bundle.getmembers():
            if item.name == "manifest.json":
                continue
            name = member_name(item.name)
            if name not in expected or item.size != expected[name]["size"] or not item.isfile():
                raise ValueError("Backup changed during restoration")
            path = destination.joinpath(*PurePosixPath(name).parts)
            if not path.resolve().is_relative_to(destination.resolve()):
                raise ValueError("Restore path escaped its destination")
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with path.open("xb") as output, bundle.extractfile(item) as source:
                os.chmod(path, 0o600)
                hasher = hashlib.sha256()
                while chunk := source.read(65536):
                    output.write(chunk); hasher.update(chunk)
                if hasher.hexdigest() != expected[name]["sha256"]:
                    raise ValueError("Backup changed during restoration; leave the new directory inactive")
    with closing(sqlite3.connect((destination / DB_NAME).as_uri() + "?mode=ro", uri=True)) as connection:
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("Restored audit database failed integrity validation")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    save = commands.add_parser("backup"); save.add_argument("--vault", type=Path, required=True); save.add_argument("--out", type=Path, required=True)
    check = commands.add_parser("verify"); check.add_argument("archive", type=Path)
    recover = commands.add_parser("restore"); recover.add_argument("archive", type=Path); recover.add_argument("--to", type=Path, required=True)
    args = parser.parse_args()
    result = backup(args.vault, args.out) if args.command == "backup" else restore(args.archive, args.to) if args.command == "restore" else inspect_archive(args.archive)
    print(f"{args.command}: verified {len(result['files'])} canonical/audit files; no running service or current vault was replaced.")


if __name__ == "__main__":
    main()
