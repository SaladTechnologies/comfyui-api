"""Read-only release and GHCR checks; publication is handled by imagetools."""
import argparse
import hashlib
import json
import os
import subprocess
import urllib.error
import urllib.request

REPO = "SaladTechnologies/comfyui-api"
IMAGE = "ghcr.io/saladtechnologies/comfyui-api"
REGISTRY = "https://ghcr.io/v2/saladtechnologies/comfyui-api/"
MAIN = "0727370b9202bcba7a790466d2d0fa51cc7156bd"
SOURCE_TREE = "8928029d0932c1eb1235a2bb4da0c528c44aef59"
RELEASE_ID = 391577625
RUNTIME = "sha256:36aa037f13b3cac57457bfbae9d3a019dfebebb811f49c5488775a442b3daef2"
DREAMSHAPER = "sha256:54965e4a62515b7edc4685d8455937da85f3a62134fdc8ce8c2bc4f8b33585af"
PREVIOUS_LATEST = "sha256:38dc1b6bd1b2adde1afeec689e42128a62daf429cce3ca5bcdcd6ae771c4bc12"
BASE = "sha256:5cc4f79f21e61b9da46e94286c29ef8185520117452027a6f5574cf6125c0ff8"
BINARY_SHA = "0974f26f1b9b8b150fff93bdb84e6758c64f283cba37eee3a8e0178976eda0c5"
SOURCE_SHA = "c57ddf4c2fffe5367a90ca7e066c77a76cd98af72cde97422413203dbac3c963"
PREFIX = "comfy0.35.0-api1.19.2-torch2.13.0-cuda13.0-"
PRESETS = {
    "dreamshaper8": DREAMSHAPER,
    "sdxl": "sha256:6baab3bdae57bc0ba4baa18f67acb38169ce72033b87517d3281877de66bf414",
    "flux1schnell": "sha256:b691663f1cd7a16b0e472dbac39fc19d947ab36997f7a7c91ded9d1b5dda2b99",
    "flux1dev": "sha256:29dd6224e6a073b591cfca56e7c4d9dbdbf5b20f6fde30344128fddd3f700fab",
    "sd35medium": "sha256:ee2bdfc6aa1070c171e8e55182bbfb23ee2cf744a42af76d38da78414f00bc19",
}
STABLE = {PREFIX + "runtime": RUNTIME, **{PREFIX + preset: digest for preset, digest in PRESETS.items()}}
UNCHANGED = {
    "base": BASE,
    "latest": RUNTIME,
    "comfy0.35.0-api1.19.1-torch2.13.0-cuda13.0-runtime": PREVIOUS_LATEST,
    "comfy0.35.0-api1.19.1-torch2.13.0-cuda13.0-dreamshaper8": "sha256:6da741c9990eb5248944370125cb33eec2210dee9ef5a275679c106baae542d5",
    "comfy0.35.0-api1.19.1-torch2.13.0-cuda13.0-sdxl": "sha256:85cf88af707b748583298739236174e1082504d5d959579496393581da4ff223",
    "comfy0.35.0-api1.19.1-torch2.13.0-cuda13.0-flux1schnell": "sha256:f5b583d5d65f90f8df23d405cfcf5cba011b6dafcdfe051e5fb9fab12a377f56",
    "comfy0.35.0-api1.19.1-torch2.13.0-cuda13.0-flux1dev": "sha256:5fd64354ee9372bf280302cb58b614ca81ae5e547f2f31305b8da4316af3f6ba",
    "comfy0.35.0-api1.19.1-torch2.13.0-cuda13.0-sd35medium": "sha256:22ee11731ede250d88fd5b5cc214dcba58d350e942dd355f9eb20553f6155c6f",
    PREFIX + "runtime-securitytest-199b1791701a": RUNTIME,
    PREFIX + "runtime": RUNTIME,
    PREFIX + "dreamshaper8": DREAMSHAPER,
    **{PREFIX + "securitytest-f38cb29a1459-" + preset: digest for preset, digest in PRESETS.items()},
}
ACCEPT = ",".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))


def github(path):
    return json.loads(subprocess.check_output(
        ["gh", "api", "repos/" + REPO + path], timeout=45
    ))


def get(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read()
    return json.loads(data), "sha256:" + hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=("before", "after"))
    parser.add_argument("--check-draft", action="store_true")
    args = parser.parse_args()
    stage = args.stage
    for key, expected in {"IMAGE": IMAGE}.items():
        if key in os.environ:
            assert os.environ[key] == expected, key
    assert github("/git/ref/heads/main")["object"]["sha"] == MAIN
    assert github("/git/commits/" + MAIN)["tree"]["sha"] == SOURCE_TREE
    # GitHub restricts draft metadata to tokens with broader repository access.
    # CI checks the successful release build below; the operator can verify the
    # draft separately without granting the image-promotion job contents:write.
    release = None
    if args.check_draft:
        release = github("/releases/" + str(RELEASE_ID))
        assert release["tag_name"] == "1.19.2" and release["target_commitish"] == MAIN
        assert any(asset["name"] == "comfyui-api" and asset["size"] > 1000000 for asset in release["assets"])
    for run_id, commit in {
        35361712493: MAIN,
        35214310398: "199b1791701a3bee1f82b1e8d159fd11f1660aa9",
        35258893813: "f38cb29a14593e7e93fa29c25080bd76d90c7113",
    }.items():
        run = github("/actions/runs/" + str(run_id))
        assert run["head_sha"] == commit and run["conclusion"] == "success", run_id

    token, _ = get("https://ghcr.io/token?service=ghcr.io&scope=repository:saladtechnologies/comfyui-api:pull")
    headers = {"Authorization": "Bearer " + token["token"], "Accept": ACCEPT}

    def manifest(ref, optional=False):
        try:
            return get(REGISTRY + "manifests/" + ref, headers)
        except urllib.error.HTTPError as error:
            if optional and error.code == 404:
                body = json.load(error)
                assert any(item["code"] == "MANIFEST_UNKNOWN" for item in body.get("errors", [])), body
                return None, None
            raise

    def platform(ref):
        value, digest = manifest(ref)
        assert digest == ref
        if "manifests" in value:
            entry = next(item for item in value["manifests"]
                         if item.get("platform", {}).get("os") == "linux"
                         and item["platform"].get("architecture") == "amd64")
            value, actual = manifest(entry["digest"])
            assert actual == entry["digest"]
        config, actual = get(REGISTRY + "blobs/" + value["config"]["digest"], headers)
        assert actual == value["config"]["digest"]
        assert (config["os"], config["architecture"]) == ("linux", "amd64")
        labels = config["config"]["Labels"]
        assert labels["org.opencontainers.image.version"] == "1.19.2-securitytest"
        assert labels["com.salad.api.binary-sha256"] == BINARY_SHA
        assert labels["com.salad.api.source-snapshot-sha256"] == SOURCE_SHA
        env = dict(item.split("=", 1) for item in config["config"]["Env"])
        assert env["WORKFLOW_DIR"] == "/workflows"
        assert "HTTP_TRUSTED_ORIGINS" not in env and "HTTP_AUTH_HEADER_VALUE" not in env
        assert config["config"]["Cmd"] == ["./comfyui-api"]
        return value, labels, env

    runtime, runtime_labels, _ = platform(RUNTIME)
    assert runtime_labels["org.opencontainers.image.base.digest"] == BASE
    assert runtime_labels["org.opencontainers.image.revision"] == "199b1791701a3bee1f82b1e8d159fd11f1660aa9"
    for preset, digest in PRESETS.items():
        value, labels, env = platform(digest)
        assert labels["org.opencontainers.image.base.digest"] == RUNTIME
        assert labels["org.opencontainers.image.revision"] == "f38cb29a14593e7e93fa29c25080bd76d90c7113"
        assert labels["com.salad.recipe.preset"] == preset
        assert labels["com.salad.recipe.revision"] == "3ebe31f8e867b40bcd959431e0328d3df19883d3"
        assert env["MANIFEST"] == "/app/manifest.yml"
        assert env["WARMUP_PROMPT_FILE"] == "warmup.json"
        assert value["layers"][:len(runtime["layers"])] == runtime["layers"]
    for ref, expected in UNCHANGED.items():
        _, actual = manifest(ref)
        assert actual == expected, (ref, actual, expected)
    destinations = {}
    for tag, expected in STABLE.items():
        _, actual = manifest(tag, optional=stage == "before")
        assert actual in ((None, expected) if stage == "before" else (expected,)), (tag, actual)
        destinations[tag] = actual
    _, latest = manifest("latest")
    assert latest == RUNTIME, latest
    result = {"stage": stage, "verified": True, "main": MAIN,
              "release_id": RELEASE_ID, "draft_checked": release is not None,
              "release_draft": release["draft"] if release else None,
              "destinations": destinations, "latest": latest,
              "anonymous_pull_access": True, "existing_versioned_tags_unchanged": True}
    print(json.dumps(result), flush=True)
    if stage == "after" and "GITHUB_STEP_SUMMARY" in os.environ:
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write("Promoted the exact previously built preset images; no rebuild was performed.\n\n")
            for tag, digest in {**STABLE, "latest": RUNTIME}.items():
                summary.write("- `" + IMAGE + ":" + tag + "` → `" + digest + "`\n")
            summary.write("\nAll presets passed CPU checks. Only DreamShaper 8 has also passed live GPU inference tests.\n")
            summary.write("\nRelease 1.19.2, existing stable tags, latest, and portal recipes were not modified by this workflow.\n")


if __name__ == "__main__":
    main()
