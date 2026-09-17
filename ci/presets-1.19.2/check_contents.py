"""Validate the actual image without downloading model weights."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import yaml

PRESETS = {
    "dreamshaper8": ("dreamshaper8.yml", "dreamshaper8.json"),
    "sdxl": ("sdxl-with-refiner.yml", "sdxl-with-refiner.json"),
    "flux1schnell": ("flux1schnell.yml", "fluxschnell.json"),
    "flux1dev": ("flux1dev.yml", "fluxdev.json"),
    "sd35medium": ("sd3.5-medium.yml", "sd3.5-medium.json"),
}
root = Path("/opt/ComfyUI")
source = Path("/recipe-source")
preset = sys.argv[1]
manifest_name, warmup_name = PRESETS[preset]
assert hashlib.sha256((root / "comfyui-api").read_bytes()).hexdigest() == (
    "0974f26f1b9b8b150fff93bdb84e6758c64f283cba37eee3a8e0178976eda0c5"
)
sys.path.insert(0, str(root))
import comfyui_version
assert comfyui_version.__version__ == "0.35.0"
assert importlib.metadata.version("torch") == "2.13.0+cu130"
assert Path("/app/manifest.yml").read_bytes() == (source / "manifests" / manifest_name).read_bytes()
assert (root / "warmup.json").read_bytes() == (source / "warmups" / warmup_name).read_bytes()
expected = sorted(path.name for path in (source / "workflows" / preset).glob("*.ts"))
actual = sorted(path.name for path in Path("/workflows").glob("*.ts"))
assert actual == expected and actual, (actual, expected)
for name in expected:
    assert (Path("/workflows") / name).read_bytes() == (source / "workflows" / preset / name).read_bytes()
manifest = yaml.safe_load(Path("/app/manifest.yml").read_text())
model_paths = [item["local_path"] for item in manifest["models"]["before_start"]]
assert len(model_paths) == len(set(model_paths))
for path in model_paths:
    assert path.startswith("models/") and ".." not in Path(path).parts, path
filenames = {Path(path).name for path in model_paths}
warmup = json.loads((root / "warmup.json").read_text())
assert any(node["class_type"] == "SaveImage" for node in warmup.values())
model_keys = {"ckpt_name", "clip_name", "clip_name1", "clip_name2", "clip_name3", "vae_name", "unet_name"}
for node in warmup.values():
    for key, value in node["inputs"].items():
        if key in model_keys:
            assert value in filenames, (key, value, filenames)
        elif isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
            assert value[0] in warmup, value
print(json.dumps({"preset": preset, "manifest_models": model_paths, "workflows": expected, "contents": "passed"}))
