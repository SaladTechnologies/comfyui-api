"""Read-only GHCR checks; never log registry tokens or modify existing tags."""
import argparse
import hashlib
import json
import os
import urllib.error
import urllib.request

REPO = "saladtechnologies/comfyui-api"
PREFIX = "comfy0.35.0-api1.19.1-torch2.13.0-cuda13.0-"
BASE = "sha256:38dc1b6bd1b2adde1afeec689e42128a62daf429cce3ca5bcdcd6ae771c4bc12"
RECIPE_REVISION = "3ebe31f8e867b40bcd959431e0328d3df19883d3"
PRESETS = ("dreamshaper8", "sdxl", "flux1schnell", "flux1dev", "sd35medium")
ACCEPT = ", ".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))


def get(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read()
        return json.loads(data), "sha256:" + hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("before", "after"))
    parser.add_argument("preset", choices=PRESETS)
    args = parser.parse_args()
    token, _ = get("https://ghcr.io/token?service=ghcr.io&scope=repository:" + REPO + ":pull")
    headers = {"Authorization": "Bearer " + token["token"], "Accept": ACCEPT}

    def manifest(tag):
        return get("https://ghcr.io/v2/" + REPO + "/manifests/" + tag, headers)

    unchanged = {
        PREFIX + "runtime": BASE,
        "latest": BASE,
        "base": "sha256:5cc4f79f21e61b9da46e94286c29ef8185520117452027a6f5574cf6125c0ff8",
        "comfy0.35.0-api1.19.0-torch2.13.0-cuda13.0-runtime": "sha256:942a89a79b8e34026e0c52a79ddd6a97e1626a5dabc0b147319c06b3bd0f96a0",
    }
    for tag, expected in unchanged.items():
        _, actual = manifest(tag)
        assert actual == expected, (tag, actual, expected)
    tag = PREFIX + args.preset
    if args.mode == "before":
        try:
            manifest(tag)
        except urllib.error.HTTPError as error:
            body = json.load(error)
            assert error.code == 404 and any(
                item["code"] == "MANIFEST_UNKNOWN" for item in body.get("errors", [])
            ), (error.code, body)
        else:
            raise RuntimeError("Refusing to overwrite an existing versioned tag: " + tag)
        print("Shared tags unchanged; destination is unused: " + tag, flush=True)
        return

    published, digest = manifest(tag)
    base, _ = manifest(BASE)
    assert published["layers"][:len(base["layers"])] == base["layers"]
    config, _ = get("https://ghcr.io/v2/" + REPO + "/blobs/" + published["config"]["digest"], headers)
    assert (config["os"], config["architecture"]) == ("linux", "amd64")
    labels = config["config"]["Labels"]
    assert labels["org.opencontainers.image.base.digest"] == BASE
    assert labels["org.opencontainers.image.version"] == "1.19.1"
    assert labels["com.salad.recipe.revision"] == RECIPE_REVISION
    assert labels["com.salad.recipe.preset"] == args.preset
    if "GITHUB_SHA" in os.environ:
        assert labels["org.opencontainers.image.revision"] == os.environ["GITHUB_SHA"]
    env = dict(item.split("=", 1) for item in config["config"]["Env"])
    assert env["MANIFEST"] == "/app/manifest.yml"
    assert env["WARMUP_PROMPT_FILE"] == "warmup.json"
    assert env["WORKFLOW_DIR"] == "/workflows"
    assert config["config"]["Cmd"] == ["./comfyui-api"]
    result = {"image": "ghcr.io/" + REPO + ":" + tag, "digest": digest, "verified": True}
    print(json.dumps(result), flush=True)
    if "GITHUB_STEP_SUMMARY" in os.environ:
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write("Published `" + result["image"] + "`\n\nDigest: `" + digest + "`\n\n")
            summary.write("CPU smoke checks passed. Full model inference requires a GPU test.\n")


if __name__ == "__main__":
    main()
