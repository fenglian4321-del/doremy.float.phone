"""Task-local Windows toolchain. Never auto-accept an SDK license or read signing secrets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile

SDK_URL = "https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip"
SDK_SHA256 = "90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a"
SDK_TERMS = "https://developer.android.com/studio/terms"
HOST_KEYS = ("SystemRoot", "WINDIR", "TEMP", "TMP", "Path", "PATH", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE")


class LicenseRequired(RuntimeError):
    pass


def consent(path):
    # A record is made only after an explicit human response; this program never
    # creates it or copies SDK license-acceptance markers from another machine.
    if path is None or not path.is_file():
        raise LicenseRequired("Android SDK许可尚未得到本人确认；未下载、安装或使用SDK。" + SDK_TERMS)
    record = json.loads(path.read_text(encoding="utf-8-sig"))
    if record.get("acceptedBy") != "human-user" or record.get("agreementUrl") != SDK_TERMS or record.get("licenseId") != "android-sdk-license" or not record.get("acceptedAt"):
        raise LicenseRequired("SDK确认记录不匹配；不能代用户默认同意。")


def hash_file(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def unpack(archive, destination):
    destination = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        for item in bundle.infolist():
            target = (destination / item.filename).resolve()
            # Windows ZipInfo normalizes backslashes in filename; inspect the
            # original archive name as well, before extracting any entry.
            if not target.is_relative_to(destination) or "\\" in item.orig_filename or "\x00" in item.orig_filename or stat.S_ISLNK(item.external_attr >> 16):
                raise RuntimeError("Unsafe tool archive path")
        # Official SDK dependency names can exceed legacy MAX_PATH when the
        # task workspace itself is long. No machine-wide registry change.
        extraction_path = Path("\\\\?\\" + str(destination)) if os.name == "nt" and not str(destination).startswith("\\\\?\\") else destination
        bundle.extractall(extraction_path)


def site_url(raw):
    value = urllib.parse.urlsplit(raw)
    if value.scheme != "https" or value.username or value.password or value.query or value.fragment or value.path not in ("", "/") or not value.hostname or not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", value.hostname):
        raise ValueError("构建站点必须是无凭据的HTTPS根地址。")
    if value.port not in (None, 443):
        raise ValueError("本测试构建仅使用标准HTTPS端口。")
    return "https://" + value.hostname.lower()


def isolated_env(root, paths, site, source=None):
    source = os.environ if source is None else source
    # Deliberately do not enumerate/copy the host environment. In particular,
    # SHELL_KEYSTORE_* and arbitrary JVM/Gradle options never enter this build.
    env = {key: source[key] for key in HOST_KEYS if key in source}
    profile = root / "private/profile"
    temporary = root / "private/tmp"
    env.update(JAVA_HOME=paths["jdk"], GRADLE_USER_HOME=str(root / "gradle-user-home"),
               ANDROID_HOME=str(root / "sdk"), ANDROID_SDK_ROOT=str(root / "sdk"), ANDROID_USER_HOME=str(profile / ".android"),
               SHELL_SITE_URL=site, JAVA_TOOL_OPTIONS=f'"-Duser.home={profile.as_posix()}" "-Djava.io.tmpdir={temporary.as_posix()}"')
    return env


def run(arguments, env, cwd, log=None):
    if log:
        with log.open("w", encoding="utf-8") as output:
            result = subprocess.run(arguments, env=env, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, text=True)
    else:
        result = subprocess.run(arguments, env=env, cwd=cwd)
    if result.returncode:
        raise RuntimeError("工具退出码 " + str(result.returncode) + ("；日志：" + str(log) if log else ""))


def sdk_prepare(root, record):
    consent(record)  # Must precede every SDK download and extraction.
    destination = root / "sdk/cmdline-tools/15859902"
    archive = root / "downloads/commandlinetools-win-15859902_latest.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        temporary = archive.with_suffix(".partial")
        with urllib.request.urlopen(SDK_URL, timeout=60) as response, temporary.open("wb") as output:
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                output.write(chunk)
        if hash_file(temporary) != SDK_SHA256:
            raise RuntimeError("Official SDK SHA-256 mismatch")
        temporary.rename(archive)
    if hash_file(archive) != SDK_SHA256:
        raise RuntimeError("Official SDK SHA-256 mismatch")
    complete = destination / ".verified-archive.sha256"
    if not complete.is_file() or complete.read_text(encoding="ascii").strip() != SDK_SHA256:
        # Preserve the official top-level directory, without computed moves.
        # A failed/partial extraction has no completion marker and is retried.
        unpack(archive, destination)
        complete.write_text(SDK_SHA256 + "\n", encoding="ascii")
    return destination / "cmdline-tools/bin/sdkmanager.bat"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "sdk-prepare", "sdk-install", "build"))
    parser.add_argument("--toolchain-root", required=True, type=Path)
    parser.add_argument("--consent-record", type=Path)
    parser.add_argument("--site-url", default="https://float.fanqielove.duckdns.org")
    args = parser.parse_args()
    root = args.toolchain_root.resolve()
    # Batch launchers interpret shell characters, so keep their workspace path narrow.
    if re.search(r'[&|<>^%!"\r\n]', str(root)):
        raise ValueError("Toolchain path contains unsupported launcher characters")
    paths = json.loads((root / "paths.json").read_text(encoding="utf-8"))
    lock = json.loads((root / "official-lock.json").read_text(encoding="utf-8"))
    for tool in lock:
        if hash_file(root / "downloads" / tool["name"]) != tool["sha256"]:
            raise RuntimeError("Prepared tool archive hash mismatch")
    for folder in (root / "private/profile/.android", root / "private/tmp", root / "gradle-user-home"):
        folder.mkdir(parents=True, exist_ok=True)
    env = isolated_env(root, paths, site_url(args.site_url))
    java = Path(paths["jdk"]) / "bin/java.exe"
    launcher = Path(paths["gradle"]) / "lib/gradle-launcher-8.11.1.jar"
    if args.action == "status":
        run([str(java), "-cp", str(launcher), "org.gradle.launcher.GradleMain", "--version", "--no-daemon", "--no-scan"], env, root)
        print("SDK许可仍单独检查；status不下载SDK、不读签名密钥。")
        return
    consent(args.consent_record)
    if args.action in ("sdk-prepare", "sdk-install"):
        manager = sdk_prepare(root, args.consent_record)
        if args.action == "sdk-prepare":
            print("已核验SDK工具；尚未接受任何sdkmanager交互提示。")
            return
        # Interactive stdin is intentional: no 'yes', blanket --licenses or
        # pre-created license hashes. Inspect the actual terms before answering.
        run([str(manager), "--sdk_root=" + str(root / "sdk"), "platforms;android-36", "build-tools;35.0.0"], env, root)
        return
    sdk = root / "sdk"
    for required in (sdk / "platforms/android-36/android.jar", sdk / "build-tools/35.0.0/aapt2.exe"):
        if not required.is_file():
            raise RuntimeError("所需SDK尚未安装；未启动APK构建。")
    repo = Path(__file__).resolve().parents[2]
    jvm = f'-Xmx2048m -Dfile.encoding=UTF-8 "-Duser.home={root.as_posix()}/private/profile" "-Djava.io.tmpdir={root.as_posix()}/private/tmp"'
    command = [str(java), "-cp", str(launcher), "org.gradle.launcher.GradleMain", "-p", str(repo / "android-shell"),
               "--no-daemon", "--no-scan", "--console=plain", "-Dorg.gradle.java.home=" + paths["jdk"], "-Dorg.gradle.jvmargs=" + jvm, "assembleDebug"]
    run(command, env, repo, root / "assemble-debug.log")
    apk = repo / "android-shell/app/build/outputs/apk/debug/app-debug.apk"
    if not apk.is_file():
        raise RuntimeError("Gradle未产生预期测试APK。")
    result = dict(apk=str(apk), bytes=apk.stat().st_size, sha256=hash_file(apk), site=env["SHELL_SITE_URL"], signatureVerification="pending-apksigner", installed=False, existingSignatureCompatibility="unknown")
    (root / "build-result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except LicenseRequired as failure:
        print(str(failure), file=sys.stderr)
        raise SystemExit(3)
