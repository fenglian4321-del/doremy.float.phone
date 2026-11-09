"""Verify a local test APK with installed official SDK tools, then export public artifacts only."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
import zipfile

from local_build import consent, hash_file, isolated_env, site_url


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toolchain-root", required=True, type=Path)
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--outdir", required=True, type=Path)
    parser.add_argument("--stage", required=True)
    parser.add_argument("--site-url", default="https://float.fanqielove.duckdns.org")
    args = parser.parse_args()
    if not re.fullmatch(r"(?:phase[1-9][0-9]*|final)", args.stage):
        raise ValueError("Expected a phase number or final")
    root, apk, output = args.toolchain_root.resolve(), args.apk.resolve(), args.outdir.resolve()
    repo = Path(__file__).resolve().parents[2]
    if not apk.is_relative_to(repo / "android-shell/app/build/outputs/apk") or not apk.is_file():
        raise ValueError("Expected the local Android build output")
    consent(root / "private/sdk-consent.json")
    paths = json.loads((root / "paths.json").read_text(encoding="utf-8"))
    site = site_url(args.site_url)
    env = isolated_env(root, paths, site)
    sdk = root / "sdk/build-tools/35.0.0"
    java = Path(paths["jdk"]) / "bin/java.exe"

    def capture(command, name):
        result = subprocess.run(command, env=env, cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="replace")
        (root / name).write_text(result.stdout + result.stderr, encoding="utf-8")
        if result.returncode:
            raise RuntimeError("APK verification tool failed: " + name)
        return result.stdout

    signature = capture([str(java), "-jar", str(sdk / "lib/apksigner.jar"), "verify", "--verbose", "--print-certs", str(apk)], "apk-signature.log")
    cert = re.search(r"Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]{64})", signature)
    if not cert or "Verified using v2 scheme (APK Signature Scheme v2): true" not in signature or "Number of signers: 1" not in signature:
        raise RuntimeError("Expected one verified v2 signer")
    badging = capture([str(sdk / "aapt2.exe"), "dump", "badging", str(apk)], "apk-badging.log")
    package = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    build_source = (repo / "android-shell/app/build.gradle").read_text(encoding="utf-8")
    expected_code = re.search(r"versionCode\s+(\d+)", build_source).group(1)
    expected_version = re.search(r'versionName\s+"([^"]+)"', build_source).group(1)
    if not package or package.group(1) != "app.floatphone.shell" or package.group(2) != expected_code or package.group(3) != expected_version:
        raise RuntimeError("APK package or version differs from the intended build")
    if not re.search(r"(?:minSdkVersion|sdkVersion):'26'", badging) or "targetSdkVersion:'34'" not in badging or "application-debuggable" not in badging or "compileSdkVersion='36'" not in badging:
        raise RuntimeError("Expected min26/target34 debug test build")
    tree = capture([str(sdk / "aapt2.exe"), "dump", "xmltree", str(apk), "--file", "AndroidManifest.xml"], "apk-manifest-tree.log")
    if not re.search(r"android:allowBackup[^\n=]*=(?:false\b|\(type 0x12\)0x0\b)", tree):
        raise RuntimeError("APK automatic backup is not demonstrably disabled")
    # Badging appends platform-implied permissions (legacy WRITE implies READ).
    # Compare actual XML declarations, rather than treating those as new nodes.
    permissions = []
    lines = tree.splitlines()
    for index, line in enumerate(lines):
        element = re.match(r"^(\s*)E: uses-permission(?:-sdk-23)? ", line)
        if not element:
            continue
        indent = len(element.group(1))
        attributes = []
        for following in lines[index + 1:]:
            if following.strip() and len(following) - len(following.lstrip()) <= indent:
                break
            attributes.append(following)
        block = "\n".join(attributes)
        name = re.search(r'android:name[^\n=]*="([^"]+)"', block)
        bound = re.search(r"android:maxSdkVersion[^\n=]*=(?:\(type 0x10\))?(0x[0-9a-fA-F]+|[0-9]+)", block)
        if not name:
            raise RuntimeError("Could not parse an APK permission declaration")
        permissions.append({"name": name.group(1), **({"maxSdkVersion": int(bound.group(1), 0)} if bound else {})})
    implied = [{"name": match.group(1), "maxSdkVersion": int(match.group(2)), "reason": match.group(3)} for match in re.finditer(r"uses-implied-permission: name='([^']+)' maxSdkVersion='(\d+)' reason='([^']+)'", badging)]
    android = "{http://schemas.android.com/apk/res/android}"
    source = ET.parse(repo / "android-shell/app/src/main/AndroidManifest.xml").getroot()
    expected = {element.attrib[android + "name"]: element.attrib.get(android + "maxSdkVersion") for element in source.findall("uses-permission")}
    generated_permission = "app.floatphone.shell.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
    for permission in permissions:
        name = permission["name"]
        if name not in expected and name != generated_permission:
            raise RuntimeError("APK introduced an unreviewed permission: " + name)
        if name in expected and permission.get("maxSdkVersion") != (int(expected[name]) if expected[name] is not None else None):
            raise RuntimeError("APK permission SDK bound differs: " + name)
    if not set(expected).issubset({permission["name"] for permission in permissions}):
        raise RuntimeError("APK is missing a source permission")
    for permission in implied:
        if permission != {"name": "android.permission.READ_EXTERNAL_STORAGE", "maxSdkVersion": 28, "reason": "requested WRITE_EXTERNAL_STORAGE"} or expected.get("android.permission.WRITE_EXTERNAL_STORAGE") != "28":
            raise RuntimeError("Unreviewed platform-implied permission")
    if generated_permission in {permission["name"] for permission in permissions}:
        blocks = tree.split("E: permission ")
        if not any(generated_permission in block.split("E:", 1)[0] and re.search(r"android:protectionLevel[^\n=]*=(?:0x0*2\b|\(type 0x11\)0x2\b)", block.split("E:", 1)[0]) for block in blocks[1:]):
            raise RuntimeError("AndroidX generated receiver permission must be signature-only")
    with zipfile.ZipFile(apk) as bundle:
        names = bundle.namelist()
        if any(name.lower().endswith((".keystore", ".jks", ".p12", ".pfx", ".key")) for name in names):
            raise RuntimeError("Unexpected private key artifact in APK")
        dex = b"\n".join(bundle.read(name) for name in names if re.fullmatch(r"classes[0-9]*\.dex", name))
        required = [site, "ScopedFilesBridge", "getScopedFilesCapabilities", "requestScopedDirectory", "submitScopedFiles", "getScopedFilesResult", "verifyScopedFiles", "cancelScopedFiles", "DeviceUiBridge", "composedTasks", "invalidateDocument", "getDeviceUiCapabilities", "requestDeviceUiGrant", "activateDeviceUiGrant", "submitDeviceUi", "getDeviceUiResult", "getDeviceUiReceipt", "cancelDeviceUi", "revokeDeviceUiGrant", "XinchaoOfflineWake", "getXinchaoOfflineWakeStatus", "setXinchaoOfflineWakeEnabled"]
        if not all(value.encode("ascii") in dex for value in required):
            raise RuntimeError("Site or scoped native bridge missing from compiled DEX")
        if bundle.testzip() is not None:
            raise RuntimeError("Corrupt APK archive")
    result = {"format": "float-local-test-apk/v1", "stage": args.stage, "applicationId": package.group(1), "versionCode": int(package.group(2)), "versionName": package.group(3), "site": site, "compileSdk": 36, "minSdk": 26, "targetSdk": 34, "debuggable": True, "automaticBackup": False, "bytes": apk.stat().st_size, "sha256": hash_file(apk), "signature": {"verified": True, "schemeV2": True, "certificateSha256": cert.group(1).lower(), "existingInstallationCompatibility": "unknown"}, "permissions": permissions, "platformImpliedPermissions": implied, "compiledScopedBridge": True, "compiledDeviceUiBridge": True, "compiledComposedTasks": True, "compiledXinchaoOfflineWake": True, "deviceValidated": False, "installed": False, "aiPhoneFilesDefaultOff": True}
    output.mkdir(parents=True, exist_ok=True)
    name = "float-" + args.stage + "-" + package.group(3) + "-debug.apk"
    with apk.open("rb") as source_apk, (output / name).open("xb") as target:
        shutil.copyfileobj(source_apk, target)
    if hash_file(output / name) != result["sha256"]:
        raise RuntimeError("Exported APK hash mismatch")
    result["artifact"] = name
    with (output / ("float-" + args.stage + "-apk-manifest.json")).open("x", encoding="utf-8") as manifest:
        manifest.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
