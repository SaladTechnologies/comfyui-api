import json
import os
from pathlib import Path
import subprocess
import sys

scripts = Path(__file__).parent
root = Path(os.environ["ARTIFACT_DIR"])
metadata = json.loads((root / "build-metadata.json").read_text())
mode = sys.argv[1]
assert mode in ("isolated", "public")
name = "comfy-security-1192-" + metadata["source_snapshot_sha256"][:10] + "-" + mode
existing = subprocess.run(["docker", "container", "inspect", name], capture_output=True)
assert existing.returncode != 0, "Refusing to reuse an existing container"

if mode == "isolated":
    actual = subprocess.check_output(["docker", "run", "--rm", "--network=none", "--memory=1g",
                                     "--entrypoint", "sha256sum", metadata["image"],
                                     "/opt/ComfyUI/comfyui-api"], text=True).split()[0]
    assert actual == metadata["binary_sha256"], (actual, metadata["binary_sha256"])
    print("Packaged binary SHA256 verified: " + actual, flush=True)

command = ["docker", "run", "--detach", "--name", name, "--network=" + ("none" if mode == "isolated" else "bridge"),
           "--memory=6g", "--cpus=2", "--tmpfs", "/smoke-cache:rw,size=64m",
           "--tmpfs", "/hf-smoke:rw,size=64m", "--mount",
           "type=bind,src=" + str(scripts / "smoke.py") + ",dst=/verification/smoke.py,readonly"]
env = {
    "CACHE_DIR": "/smoke-cache",
    "HOST": "127.0.0.1",
    "STARTUP_CHECK_MAX_TRIES": "180",
    "CMD": "python3 main.py --cpu --disable-auto-launch --disable-all-custom-nodes",
    "MANIFEST_JSON": '{"models":{}}',
    "WARMUP_PROMPT_FILE": "",
    "HF_HOME": "/hf-smoke",
    "HF_HUB_CACHE": "/hf-smoke/hub",
    "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "HF_ENDPOINT": "https://huggingface.co",
}
if mode == "isolated":
    env.update({
        "HTTP_TRUSTED_ORIGINS": "http://127.0.0.1:9187,http://127.0.0.1:9189",
        "HTTP_AUTH_HEADER_NAME": "X-Review-Token",
        "HTTP_AUTH_HEADER_VALUE": "dummy-not-a-secret",
        "HTTP_AUTH_ALLOWED_ORIGINS": "http://127.0.0.1:9187",
    })
for key, value in env.items():
    command.extend(["-e", key + "=" + value])
command.append(metadata["image"])

container = None
try:
    container = subprocess.check_output(command, text=True).strip()
    print("Started disposable " + mode + " CPU smoke container " + container[:12], flush=True)
    with (root / (mode + "-smoke.log")).open("w") as log:
        result = subprocess.run(["docker", "exec", container, "python3", "/verification/smoke.py", mode],
                                stdout=log, stderr=subprocess.STDOUT, timeout=420)
    output = (root / (mode + "-smoke.log")).read_text()
    print(output, flush=True)
    if result.returncode:
        raise SystemExit(result.returncode)
    report = json.loads(output.strip().splitlines()[-1])
    (root / (mode + "-smoke.json")).write_text(json.dumps(report, indent=2) + "\n")
finally:
    if container:
        logs = subprocess.run(["docker", "logs", container], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (root / (mode + "-container.log")).write_text(logs.stdout)
        if not (root / (mode + "-smoke.json")).exists():
            print(logs.stdout[-16000:], flush=True)
        status = subprocess.check_output(["docker", "container", "inspect", container], text=True)
        (root / (mode + "-container.json")).write_text(status)
        subprocess.run(["docker", "rm", "--force", container], check=True, stdout=subprocess.DEVNULL)
        print("Removed disposable " + mode + " CPU smoke container", flush=True)
