"""CPU integration checks; no real model weights or GPU inference are used."""
import base64
import http.server
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

preset = sys.argv[1]


def request(route, payload=None, timeout=30, expected=200, port=3000):
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


deadline = time.monotonic() + 150
while True:
    try:
        ready = request("/ready", timeout=2)
        break
    except (OSError, AssertionError):
        if time.monotonic() >= deadline:
            raise
        time.sleep(1)
assert ready == {"version": "1.19.1", "status": "ready"}, ready
assert request("/health") == {"version": "1.19.1", "status": "healthy"}
models = request("/models")
assert isinstance(models, dict)
assert set(models) == set(request("/models", port=8188))
assert {"checkpoints", "text_encoders", "diffusion_models"} <= models.keys()
assert all(isinstance(files, list) and all(isinstance(name, str) for name in files)
           for files in models.values())
docs = request("/docs/json")
routes = sorted("/workflow/" + path.stem for path in Path("/workflows").glob("*.ts"))
assert routes
assert sorted(route for route in docs["paths"] if route.startswith("/workflow/")) == routes
for route in routes:
    assert "post" in docs["paths"][route]
    request(route, {"input": {"prompt": 123}}, expected=400)
probe = Path("/opt/ComfyUI/models/checkpoints/ci-preset-listing.safetensors")
assert not probe.exists()
try:
    probe.write_bytes(b"")
    assert probe.name in request("/models")["checkpoints"]
finally:
    probe.unlink(missing_ok=True)

fixture = io.BytesIO()
Image.new("RGB", (64, 64), (128, 64, 32)).save(fixture, format="PNG")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.path == "/input.png", self.path
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.end_headers()
        self.wfile.write(fixture.getvalue())


server = http.server.ThreadingHTTPServer(("127.0.0.1", 9187), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
input_dir = Path("/opt/ComfyUI/input")
assert os.stat("/smoke-cache").st_dev != input_dir.stat().st_dev
existing = set(input_dir.rglob("*"))
prompt = {
    "1": {"class_type": "LoadImage", "inputs": {"image": "http://127.0.0.1:9187/input.png"}},
    "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "ci-preset-smoke"}},
}
try:
    for name in ("input-staging", "cached-input"):
        result = request("/prompt", {"id": preset + "-" + name, "prompt": prompt}, timeout=90)
        assert len(result.get("images", [])) == 1, result
        output = base64.b64decode(result["images"][0], validate=True)
        with Image.open(io.BytesIO(output)) as image:
            image.load()
            assert image.format == "PNG" and image.size == (64, 64)
    staged = [path for path in input_dir.rglob("*") if path not in existing and path.is_file()]
    assert staged and all(not path.is_symlink() for path in staged)
finally:
    server.shutdown()
print(json.dumps({"preset": preset, "api": "1.19.1", "routes": routes, "cpu_smoke": "passed", "gpu_inference": "not_run"}), flush=True)
