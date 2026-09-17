"""Exercise the packaged API and real ComfyUI on CPU using disposable fixtures."""
import base64
import hashlib
import http.server
import importlib.metadata
import io
import json
import os
from pathlib import Path
import sys
import threading
import time
import urllib.error
import urllib.request

from PIL import Image
sys.path.insert(0, "/opt/ComfyUI")
import comfyui_version

mode = sys.argv[1]
assert mode in ("isolated", "public")
assert comfyui_version.__version__ == "0.35.0"
assert importlib.metadata.version("torch") == "2.13.0+cu130"
checks = []


def passed(name):
    checks.append(name)
    print("PASS " + name, flush=True)


def request(route, payload=None, expected=200, timeout=30, port=3000):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request("http://127.0.0.1:" + str(port) + route, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = json.load(response)
        assert response.status == expected, (route, response.status, body)
        return body


def download(url, filename, expected=200, wait=True):
    body = {"url": url, "model_type": "checkpoints", "wait": wait}
    if filename is not None:
        body["filename"] = filename
    return request("/download", body, expected=expected, timeout=120)


deadline = time.monotonic() + 180
while True:
    try:
        ready = request("/ready", timeout=2)
        break
    except (OSError, AssertionError):
        if time.monotonic() >= deadline:
            raise
        time.sleep(1)
assert ready == {"version": "1.19.2", "status": "ready"}, ready
assert request("/health") == {"version": "1.19.2", "status": "healthy"}
passed("API 1.19.2 startup and health; ComfyUI 0.35.0; torch 2.13.0+cu130")

models = request("/models")
assert isinstance(models, dict)
assert set(models) == set(request("/models", port=8188))
assert {"checkpoints", "text_encoders", "diffusion_models"} <= models.keys()
assert all(isinstance(files, list) and all(isinstance(name, str) for name in files)
           for files in models.values())
model_dir = Path("/opt/ComfyUI/models/checkpoints")
probe = model_dir / "security-smoke-listing.safetensors"
assert not probe.exists()
try:
    probe.write_bytes(b"")
    assert probe.name in request("/models")["checkpoints"]
finally:
    probe.unlink(missing_ok=True)
assert "/download" in request("/docs/json")["paths"]
passed("model listing, dynamic discovery, and OpenAPI schema")

marker = b"SAFE-REVIEW-MARKER"
dummy = "dummy-not-a-secret"
requests = []
png = io.BytesIO()
Image.new("RGB", (64, 64), (128, 64, 32)).save(png, format="PNG")


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        requests.append((self.server.server_port, self.path, dict(self.headers)))
        if self.path == "/redirect.bin":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:9189/redirect-target.bin")
            self.end_headers()
            return
        if self.path == "/redirect-denied.bin":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:9188/denied-target.bin")
            self.end_headers()
            return
        data = png.getvalue() if self.path == "/input.png" else marker
        self.send_response(200)
        self.send_header("Content-Type", "image/png" if self.path == "/input.png" else "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


servers = []
try:
    for port in (9187, 9188, 9189):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)

    original = Path("/opt/ComfyUI/models/security-smoke-original.bin")
    original.write_bytes(b"original")
    names = ["../security-smoke-original.bin", "../../security-smoke-original.bin", "/tmp/proof.bin",
             "C:\\proof.bin", "C:proof.bin", "\\\\host\\share\\proof.bin", "nested/file.bin", "nested\\file.bin",
             ".", "..", "", "   ", "bad\0name.bin", "a" * 256, "NUL.txt", "．．／proof.bin"]
    for wait in (False, True):
        for filename in names:
            before = len(requests)
            response = download("http://127.0.0.1:9187/invalid.bin", filename, expected=400, wait=wait)
            assert len(requests) == before
            assert original.read_bytes() == b"original"
            assert "/opt/ComfyUI" not in json.dumps(response)
    original.unlink()
    passed("unsafe filenames rejected for synchronous/asynchronous requests before any fetch or overwrite")

    before = len(requests)
    denied = ["http://127.0.0.1:9188/denied.bin", "http://2130706433:9188/denied.bin",
              "http://0x7f000001:9188/denied.bin", "http://[::ffff:127.0.0.1]:9188/denied.bin",
              "http://10.0.0.1/denied.bin", "http://169.254.169.254/denied.bin"]
    for url in denied:
        for wait in (False, True):
            download(url, "denied.bin", expected=400, wait=wait)
    assert len(requests) == before
    assert not (model_dir / "denied.bin").exists()
    passed("private, loopback, metadata, mapped IPv6, and alternate IPv4 destinations rejected")

    if mode == "isolated":
        for url, filename, expected_auth in [
            ("http://127.0.0.1:9187/allowed.bin", "allowed.bin", dummy),
            ("http://127.0.0.1:9189/other-origin.bin", "other-origin.bin", None),
            ("http://127.0.0.1:9187/redirect.bin", "redirect.bin", None),
        ]:
            result = download(url, filename)
            assert result["status"] == "completed" and result["size"] == len(marker), result
            assert (model_dir / filename).read_bytes() == marker
            headers = {k.lower(): v for k, v in requests[-1][2].items()}
            assert headers.get("x-review-token") == expected_auth, (url, headers)
        source = [item for item in requests if item[1] == "/redirect.bin"]
        assert len(source) == 1
        assert {k.lower(): v for k, v in source[0][2].items()}.get("x-review-token") == dummy
        passed("global credential bound to one origin; absent at unrelated and redirected origins")

        before = len(requests)
        download("http://127.0.0.1:9187/redirect-denied.bin", "redirect-denied.bin", expected=400)
        assert len(requests) == before + 1 and requests[-1][0] == 9187
        assert not (model_dir / "redirect-denied.bin").exists()
        passed("redirect to a private untrusted origin blocked before connection")

        target = Path("/tmp/security-smoke-symlink-target.bin")
        target.write_bytes(b"original")
        link = model_dir / "symlink.bin"
        link.symlink_to(target)
        before = len(requests)
        download("http://127.0.0.1:9187/symlink.bin", link.name, expected=400)
        assert target.read_bytes() == b"original" and len(requests) == before
        link.unlink()
        target.unlink()
        passed("model symlink cannot overwrite a file outside the cache")

        result = download("http://127.0.0.1:9187/async.bin", "async.bin", expected=202, wait=False)
        assert result["status"] == "started"
        deadline = time.monotonic() + 10
        while not (model_dir / "async.bin").exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert (model_dir / "async.bin").read_bytes() == marker
        download("http://127.0.0.1:9187/derived.bin", None)
        assert (model_dir / "derived.bin").read_bytes() == marker
        before = len(requests)
        download("http://127.0.0.1:9187/allowed.bin", "cache-reuse.bin")
        assert (model_dir / "cache-reuse.bin").read_bytes() == marker and len(requests) == before
        assert not (Path("/smoke-cache") / "allowed.bin").exists()
        passed("synchronous/asynchronous downloads, URL-derived filenames, and hashed-cache reuse")

        input_dir = Path("/opt/ComfyUI/input")
        assert os.stat("/smoke-cache").st_dev != input_dir.stat().st_dev
        existing = set(input_dir.rglob("*"))
        prompt = {
            "1": {"class_type": "LoadImage", "inputs": {"image": "http://127.0.0.1:9187/input.png"}},
            "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "ci-security-smoke"}},
        }
        for name in ("input-staging", "cached-input"):
            result = request("/prompt", {"id": "security-" + name, "prompt": prompt}, timeout=120)
            assert len(result.get("images", [])) == 1, result
            with Image.open(io.BytesIO(base64.b64decode(result["images"][0], validate=True))) as image:
                image.load()
                assert image.format == "PNG" and image.size == (64, 64)
                assert image.convert("RGB").getpixel((0, 0)) == (128, 64, 32)
        staged = [path for path in input_dir.rglob("*") if path not in existing and path.is_file()]
        assert staged and all(not path.is_symlink() for path in staged)
        assert sum(item[1] == "/input.png" for item in requests) == 1
        passed("real ComfyUI CPU PNG roundtrip, cross-filesystem input staging, and cache reuse")
    else:
        # No trusted-origin or auth exceptions are configured in this run.
        before = len(requests)
        for port in (9187, 9189):
            download("http://127.0.0.1:" + str(port) + "/default-deny.bin", "default-deny.bin", expected=400)
        assert len(requests) == before
        passed("default configuration denies internal servers without origin exceptions")

        public_files = [
            ("https://raw.githubusercontent.com/SaladTechnologies/comfyui-api/330adc74d679edb880a58b663d5bce3ae878c0b2/package.json", "public-http.json", "http"),
            ("https://huggingface.co/Lykon/dreamshaper-8/resolve/main/model_index.json", "public-hf.json", "hf"),
        ]
        for url, filename, kind in public_files:
            result = download(url, filename)
            data = (model_dir / filename).read_bytes()
            assert result["status"] == "completed" and 0 < len(data) < 16384, result
            parsed = json.loads(data)
            if kind == "http":
                assert parsed["version"] == "1.19.1"
            else:
                assert parsed["_class_name"] == "StableDiffusionPipeline"
            passed("real public " + kind + " download: " + str(len(data)) + " bytes, sha256 " + hashlib.sha256(data).hexdigest())

    assert not list(Path("/smoke-cache").glob(".download-*.partial"))
    passed("no incomplete download files left in cache")
finally:
    for server in servers:
        server.shutdown()
        server.server_close()

print(json.dumps({"mode": mode, "api": "1.19.2", "checks": checks,
                  "cpu_smoke": "passed", "gpu_inference": "not_run"}), flush=True)
