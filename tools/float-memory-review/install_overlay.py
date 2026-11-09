"""Prepare an opt-in Ombre overlay; never download, run a server, or touch a vault.

Default is read-only --check. --apply is intended for a reviewed image build.
Refuse unknown upstream source rather than silently patching an incompatible version.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path

PINNED = {
    "server.py": "9d92b0fee79e7f5fb6e6753ccbd82f06ccb35d35",
    "bucket_manager.py": "15063091cdfba676e9feef86a64e6d470913cab7",
    "ombrebrain/policy/surfacing.py": "59d95cc0f79d6579ea112c4903408927c748352a",
    "web/_shared.py": "64f84480d5b9141c3590b9e459b0bec7ec254993",
}
HOOK = '''
# BEGIN FLOAT REVIEW OVERLAY v1
if os.environ.get("FLOAT_REVIEW_SERVICE_TOKEN"):
    from float_review_service import register as _float_register_review
    _float_review_service = _float_register_review(mcp, bucket_mgr, config)
# END FLOAT REVIEW OVERLAY v1
'''
ANCHOR = "_web.register_all(mcp)\n"
CREATE_SIGNATURE = "        media: Optional[list[dict]] = None,\n    ) -> str:\n"
CREATE_SIGNATURE_PATCHED = "        media: Optional[list[dict]] = None,\n        dont_surface: bool = False,\n    ) -> str:\n"
CREATE_METADATA = "        post = frontmatter.Post(linked_content, **metadata)  # type: ignore[arg-type]\n"
CREATE_HIDDEN = "        # FLOAT CREATE VISIBILITY: set before the first canonical file is written.\n        if parse_bool(dont_surface):\n            metadata[\"dont_surface\"] = True\n"


def git_blob(data: bytes) -> str:
    data = data.replace(b"\r\n", b"\n")
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def prepare(src: Path):
    src = src.resolve(strict=True)
    source = {}
    for filename, expected in PINNED.items():
        path = src / filename
        if path.is_symlink():
            raise RuntimeError(f"Refusing symlink: {filename}")
        raw = path.read_bytes().replace(b"\r\n", b"\n")
        if filename == "server.py" and HOOK.encode() in raw:
            raw = raw.replace(HOOK.encode(), b"", 1)
        if filename == "bucket_manager.py":
            raw = raw.replace(CREATE_SIGNATURE_PATCHED.encode(), CREATE_SIGNATURE.encode(), 1).replace(CREATE_HIDDEN.encode(), b"", 1)
        if git_blob(raw) != expected:
            raise RuntimeError(f"Unsupported or modified upstream {filename}; no files changed")
        source[filename] = raw.decode()
    if source["server.py"].count(ANCHOR) != 1:
        raise RuntimeError("Expected one registration anchor; no files changed")
    plugin = Path(__file__).with_name("review_service.py").read_bytes()
    target = src / "float_review_service.py"
    if target.is_symlink() or (target.exists() and target.read_bytes() != plugin):
        raise RuntimeError("Existing review module differs; preserve it for manual review")
    vendor_root = Path(__file__).with_name("float_latent_vendor")
    destination = src / "float_latent_vendor"
    if destination.is_symlink():
        raise RuntimeError("Refusing symlinked Latent package")
    vendor = {}
    for path in vendor_root.iterdir():
        if path.name == "__pycache__":
            continue
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("Unexpected Latent package input")
        data = path.read_bytes()
        target_file = destination / path.name
        if target_file.is_symlink() or (target_file.exists() and target_file.read_bytes() != data):
            raise RuntimeError("Existing Latent package differs; preserve it for manual review")
        vendor[path.name] = data
    if destination.exists() and any(path.name not in vendor and path.name != "__pycache__" for path in destination.iterdir()):
        raise RuntimeError("Unexpected files in Latent package; no files changed")
    bucket = source["bucket_manager.py"]
    if bucket.count(CREATE_SIGNATURE) != 1 or bucket.count(CREATE_METADATA) != 1:
        raise RuntimeError("Expected one create visibility anchor; no files changed")
    bucket = bucket.replace(CREATE_SIGNATURE, CREATE_SIGNATURE_PATCHED, 1).replace(CREATE_METADATA, CREATE_HIDDEN + CREATE_METADATA, 1).encode()
    importer = Path(__file__).with_name("float_orbis_import.py").read_bytes()
    importer_target = src / "float_orbis_import.py"
    if importer_target.is_symlink() or (importer_target.exists() and importer_target.read_bytes() != importer):
        raise RuntimeError("Existing Orbis adapter differs; preserve it for manual review")
    semantic = Path(__file__).with_name("float_latent_semantic.py").read_bytes()
    semantic_target = src / "float_latent_semantic.py"
    if semantic_target.is_symlink() or (semantic_target.exists() and semantic_target.read_bytes() != semantic):
        raise RuntimeError("Existing semantic adapter differs; preserve it for manual review")
    provider_state = Path(__file__).with_name("float_provider_state.py").read_bytes()
    consolidation = Path(__file__).with_name("float_consolidation.py").read_bytes()
    workspaces = Path(__file__).with_name("float_workspaces.py").read_bytes()
    private_spaces = Path(__file__).with_name("float_private_spaces.py").read_bytes()
    private_target = src / "float_private_spaces.py"
    if private_target.is_symlink() or (private_target.exists() and private_target.read_bytes() != private_spaces):
        raise RuntimeError("Existing private-space adapter differs; preserve it for manual review")
    workspace_target = src / "float_workspaces.py"
    if workspace_target.is_symlink() or (workspace_target.exists() and workspace_target.read_bytes() != workspaces):
        raise RuntimeError("Existing workspace adapter differs; preserve it for manual review")
    consolidation_target = src / "float_consolidation.py"
    if consolidation_target.is_symlink() or (consolidation_target.exists() and consolidation_target.read_bytes() != consolidation):
        raise RuntimeError("Existing consolidation adapter differs; preserve it for manual review")
    provider_target = src / "float_provider_state.py"
    if provider_target.is_symlink() or (provider_target.exists() and provider_target.read_bytes() != provider_state):
        raise RuntimeError("Existing provider persistence adapter differs; preserve it for manual review")
    return src, source["server.py"].replace(ANCHOR, ANCHOR + HOOK, 1).encode(), plugin, vendor, bucket, importer, semantic, provider_state, consolidation, workspaces, private_spaces


def atomic_write(path: Path, data: bytes):
    temporary = path.with_name(path.name + ".float-install.tmp")
    with temporary.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", type=Path, required=True, help="Reviewed Ombre src directory")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    src, server, plugin, vendor, bucket, importer, semantic, provider_state, consolidation, workspaces, private_spaces = prepare(args.src)
    if args.apply:
        (src / "float_latent_vendor").mkdir(exist_ok=True)
        for filename, contents in vendor.items():
            atomic_write(src / "float_latent_vendor" / filename, contents)
        atomic_write(src / "float_review_service.py", plugin)
        atomic_write(src / "float_orbis_import.py", importer)
        atomic_write(src / "float_latent_semantic.py", semantic)
        atomic_write(src / "float_provider_state.py", provider_state)
        atomic_write(src / "float_consolidation.py", consolidation)
        atomic_write(src / "float_workspaces.py", workspaces)
        atomic_write(src / "float_private_spaces.py", private_spaces)
        atomic_write(src / "bucket_manager.py", bucket)
        atomic_write(src / "server.py", server)
        print("Float review overlay prepared. No server started; no vault accessed.")
    else:
        print("Compatible pinned source. Check only; no files changed.")


if __name__ == "__main__":
    main()
