"""Loopback-only, synthetic owner/SQLite/shared-memory fixture. Never a real vault."""
import asyncio
import json
import os
import signal
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit, parse_qs
from review_service import ReviewService, ReviewError
from test_review_service import Manager


def main():
    temporary = tempfile.TemporaryDirectory(prefix="workbench-synthetic-", dir=os.environ.get("FLOAT_TEST_WORK_DIR") or None)
    manager = Manager()
    manager.entries["memory-synthetic-1"] = {"id": "memory-synthetic-1", "content": "合成星图记忆，最初的一个片段。", "metadata": {"type": "dynamic", "name": "初见的星光", "tags": ["合成"], "created": "2026-11-10T00:00:00Z"}}
    service = ReviewService(manager, temporary.name)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def respond(self):
            status, cookies = 200, None
            path = urlsplit(self.path)
            query = {key: value[0] for key, value in parse_qs(path.query).items()}
            try:
                size = int(self.headers.get("Content-Length", 0))
                if size > 128 * 1024:
                    raise ReviewError("too_large", "Synthetic request too large", 413)
                body = json.loads(self.rfile.read(size)) if size else {}
                if path.path == "/auth/login":
                    if body.get("password") != "synthetic-dashboard":
                        raise ReviewError("unauthorized", "Synthetic login", 401)
                    result, cookies = {"ok": True}, "ombre_session=synthetic; Path=/; HttpOnly"
                elif path.path.startswith("/api/"):
                    if self.headers.get("Cookie") != "ombre_session=synthetic":
                        raise ReviewError("unauthorized", "Synthetic cookie", 401)
                    if path.path in ("/api/buckets", "/api/search"):
                        result = [{"id": row["id"], "name": row["metadata"].get("name", row["id"]), "content_preview": row["content"][:200], "type": row["metadata"].get("type", "dynamic"), "tags": row["metadata"].get("tags", []), "domain": [], "created": row["metadata"].get("created", "")} for row in manager.entries.values() if not row["metadata"].get("deleted_at")]
                    elif path.path.startswith("/api/bucket/"):
                        result = asyncio.run(manager.get(path.path.rsplit("/", 1)[1]))
                    else:
                        raise ReviewError("invalid_action", "Synthetic route", 404)
                else:
                    if not path.path.startswith("/float-memory/v2/") or self.headers.get("Authorization") != "Bearer synthetic-work-service-token-only":
                        raise ReviewError("unauthorized", "Synthetic token", 401)
                    action = path.path.rsplit("/", 1)[1]
                    if action in ("workspaces", "private_spaces"):
                        result = asyncio.run((service.workspaces if action == "workspaces" else service.private_spaces).dispatch(body))
                    elif action == "status":
                        result = dict(protocol="float-review/v2", policy=service.policy(), nativeWritesReviewed=False, latent=False, management=True, orbisImport=True, consolidation="float-consolidation/v1")
                    elif action == "detail":
                        result = dict(entry=asyncio.run(service.detail(query.get("id", ""))))
                    elif action == "catalog":
                        result = asyncio.run(service.catalog(query.get("state", "active"), query.get("cursor", "")))
                    elif action == "history":
                        result = service.history(query.get("id", ""))
                    elif action == "candidates":
                        result = service.candidates()
                    elif action == "save":
                        result = dict(candidate=asyncio.run(service.record(body, manual=True)))
                    elif action == "manage":
                        result = dict(management=asyncio.run(service.manage(body)))
                    elif action == "undo_save":
                        result = dict(candidate=asyncio.run(service.undo(body.get("id"), body.get("clientKey"))))
                    else:
                        raise ReviewError("invalid_action", "Synthetic route", 404)
                    result = {"ok": True, **result}
            except ReviewError as error:
                status, result = error.status, dict(ok=False, code=error.code, error=str(error))
            except Exception as error:
                status, result = 500, dict(ok=False, code="fixture_failure", error=str(error))
            data = json.dumps(result, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            if cookies:
                self.send_header("Set-Cookie", cookies)
            self.end_headers()
            self.wfile.write(data)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    print(json.dumps({"port": server.server_port}), flush=True)
    def stop(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        service.close()
        temporary.cleanup()


if __name__ == "__main__":
    main()
