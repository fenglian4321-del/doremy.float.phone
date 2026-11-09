"""Read-only validation of installer dependencies and Docker COPY coverage."""
import argparse
import ast
import json
from pathlib import Path
import shlex
import sys

ROOTS = {"install_overlay.py", "review_service.py", "float_provider_state.py", "check_overlay_package.py"}


def required_inputs(root):
    pending, seen = list(ROOTS), set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        path = root / name
        if Path(name).name != name or path.is_symlink() or not path.exists():
            raise RuntimeError("Missing or unsafe overlay input: " + name)
        seen.add(name)
        if path.is_dir():
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=name)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "with_name" and len(node.args) == 1 and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                pending.append(node.args[0].value)
            if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("float_"):
                module = node.module.split(".")[0]
                pending.append(module if (root / module).is_dir() else "review_service.py" if module == "float_review_service" else module + ".py")
    return seen


def docker_sources(text):
    logical, continuation = [], ""
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        continuation += line[:-1] + " " if line.endswith("\\") else line
        if not line.endswith("\\"):
            logical.append(continuation)
            continuation = ""
    copied = set()
    for line in logical:
        if line.split(" ", 1)[0].upper() != "COPY":
            continue
        values = line.split(" ", 1)[1].strip()
        parts = json.loads(values) if values.startswith("[") else shlex.split(values)
        if len(parts) < 2 or any(part.startswith("--") for part in parts):
            raise RuntimeError("Unsupported COPY form; review package checker before changing it")
        for source in parts[:-1]:
            if Path(source).name != source or any(c in source for c in "*?[\\/"):
                raise RuntimeError("COPY must use explicit local overlay inputs")
            copied.add(source)
    return copied


def validate(root, docker_text=None):
    required = required_inputs(root)
    if docker_text is not None:
        missing = required - docker_sources(docker_text)
        if missing:
            raise RuntimeError("Docker COPY omits installer dependencies: " + ", ".join(sorted(missing)))
    return required


def validate_allowlist(root, names, listed):
    expected = set()
    for name in names:
        path = root / name
        if path.is_dir():
            for child in path.iterdir():
                if child.name == "__pycache__":
                    continue
                if child.is_symlink() or not child.is_file():
                    raise RuntimeError("Unexpected vendored package entry")
                expected.add(name + "/" + child.name)
        else:
            expected.add(name)
    missing = {"tools/float-memory-review/" + name for name in expected} - set(listed)
    if missing:
        raise RuntimeError("Source archive allowlist omits overlay inputs: " + ", ".join(sorted(missing)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", type=Path, help="Validate files already copied into the image")
    parser.add_argument("--allowlist-stdin", action="store_true", help="Also validate repo-relative archive paths from JSON stdin")
    args = parser.parse_args()
    root = args.staged or Path(__file__).resolve().parent
    required = validate(root, None if args.staged else (root / "Dockerfile.overlay").read_text(encoding="utf-8"))
    if args.allowlist_stdin:
        listed = json.loads(sys.stdin.read())
        if not isinstance(listed, list) or any(not isinstance(name, str) for name in listed):
            raise RuntimeError("Expected a JSON array of source paths")
        validate_allowlist(root, required, listed)
    print(f"Overlay package verified: {len(required)} dependency inputs; no service or vault accessed.")


if __name__ == "__main__":
    main()
