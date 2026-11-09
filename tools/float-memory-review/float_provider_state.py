"""Keep the deployed provider-persistence fix when rebuilding a clean overlay.

Opt-in FLOAT_MODEL_ENV_PATH only. Values are data, never shell instructions;
the original entrypoint/config.yaml continues to own model selection.
"""
import os
from pathlib import Path
import shlex
import sys

KEYS = ("OMBRE_COMPRESS_API_KEY", "OMBRE_EMBED_API_KEY", "OMBRE_COMPRESS_BASE_URL", "OMBRE_EMBED_BASE_URL")


def private_path(raw, vault):
    path, root = Path(raw), Path(vault).resolve(strict=True)
    if not path.is_absolute() or path.is_symlink() or not path.resolve().is_relative_to(root) or not path.parent.is_dir():
        raise RuntimeError("Provider state must stay in the private vault")
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
    except FileExistsError:
        if not path.is_file():
            raise RuntimeError("Provider state must be a regular file") from None
    os.chmod(path, 0o600)
    return path


def read_values(path):
    if path.stat().st_size > 16 * 1024:
        raise RuntimeError("Provider state exceeds configuration capacity")
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() not in KEYS:
            continue
        try:
            parts = shlex.split(value.strip(), comments=False, posix=True)
        except ValueError:
            raise RuntimeError("Invalid provider setting syntax") from None
        if len(parts) > 1 or (parts and (len(parts[0]) > 4096 or "\x00" in parts[0])):
            raise RuntimeError("Invalid provider setting syntax")
        values[key.strip()] = parts[0] if parts else ""
    return values


def install_runtime(vault):
    raw = os.environ.get("FLOAT_MODEL_ENV_PATH", "")
    if not raw:
        return
    path = private_path(raw, vault)
    from web import _shared
    previous = getattr(_shared, "_float_provider_state_path", None)
    if previous is not None:
        if previous != str(path):
            raise RuntimeError("Provider state already belongs to another vault")
        return
    original = getattr(_shared, "_write_env_var", None)
    if not callable(original) or not callable(getattr(_shared, "_project_env_path", None)):
        raise RuntimeError("Unsupported native provider settings writer")
    def write_private(name, value):
        if not isinstance(value, str) or any(character in value for character in "\r\n\x00"):
            raise RuntimeError("Invalid provider setting syntax")
        private_path(raw, vault)
        original(name, value)
        os.chmod(path, 0o600)
    _shared._project_env_path = lambda: str(path)
    _shared._write_env_var = write_private
    _shared._float_provider_state_path = str(path)


def start():
    raw = os.environ.get("FLOAT_MODEL_ENV_PATH", "")
    if raw:
        values = read_values(private_path(raw, "/app/buckets"))
        for name in KEYS:
            os.environ[name] = values.get(name, "")
        for name in ("OMBRE_COMPRESS_MODEL", "OMBRE_EMBED_MODEL"):
            os.environ.pop(name, None)
    os.execv("/app/entrypoint.sh", ["/app/entrypoint.sh", *sys.argv[1:]])


if __name__ == "__main__":
    start()
