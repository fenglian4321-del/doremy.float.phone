"""Synthetic work-only HTTP host. No real vault, credentials or model access."""
import asyncio
import json
import os
from pathlib import Path
import signal
import tempfile
from http.server import HTTPServer, BaseHTTPRequestHandler
from review_service import ReviewService, ReviewError


class NoLifeManager:
    def __getattr__(self, name):
        if name in ("create", "get", "update", "list_all", "search", "delete", "restore", "purge", "archive", "touch", "touch_many", "set_anchor"):
            async def forbidden(*_args, **_kwargs):
                raise AssertionError("Work operation attempted a life-memory manager call: " + name)
            return forbidden
        raise AttributeError(name)


def main():
    temporary = tempfile.TemporaryDirectory(prefix="float-work-fixture-", dir=os.environ.get("FLOAT_TEST_WORK_DIR") or None)
    service = ReviewService(NoLifeManager(), temporary.name)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            status = 200
            if self.path not in ("/float-memory/v2/workspaces", "/float-memory/v2/private_spaces") or self.headers.get("Authorization") != "Bearer synthetic-work-service-token-only":
                status, body = 403, dict(ok=False, code="forbidden")
            else:
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    if size > 128*1024:
                        raise ReviewError("too_large", "Too large", 413)
                    scope = service.workspaces if self.path.endswith("/workspaces") else service.private_spaces
                    body = {"ok": True, **asyncio.run(scope.dispatch(json.loads(self.rfile.read(size))))}
                    assert service.db.execute("SELECT COUNT(*) FROM candidates").fetchone()[0] == 0
                    assert service.db.execute("SELECT COUNT(*) FROM consolidation_scopes").fetchone()[0] == 0
                except ReviewError as error:
                    status, body = error.status, dict(ok=False, code=error.code, error=str(error))
                except Exception as error:
                    status, body = 500, dict(ok=False, code="fixture_failure", error=str(error))
            raw = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

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
