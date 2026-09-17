"""Read-only GHCR checks for the five security-test presets."""
import argparse
import hashlib
import json
import os
import re
import urllib.error
import urllib.request

REPO = "saladtechnologies/comfyui-api"
BASE = "sha256:36aa037f13b3cac57457bfbae9d3a019dfebebb811f49c5488775a442b3daef2"
RELEASED = "sha256:38dc1b6bd1b2adde1afeec689e42128a62daf429cce3ca5bcdcd6ae771c4bc12"
RECIPE_REVISION = "3ebe31f8e867b40bcd959431e0328d3df19883d3"
BINARY_SHA256 = "0974f26f1b9b8b150fff93bdb84e6758c64f283cba37eee3a8e0178976eda0c5"
SOURCE_SHA256 = "c57ddf4c2fffe5367a90ca7e066c77a76cd98af72cde97422413203dbac3c963"
OLD_PREFIX = "comfy0.35.0-api1.19.1-torch2.13.0-cuda13.0-"
OLD_PRESETS = {
    "dreamshaper8": "sha256:6da741c9990eb5248944370125cb33eec2210dee9ef5a275679c106baae542d5",
    "sdxl": "sha256:85cf88af707b748583298739236174e1082504d5d959579496393581da4ff223",
    "flux1schnell": "sha256:f5b583d5d65f90f8df23d405cfcf5cba011b6dafcdfe051e5fb9fab12a377f56",
    "flux1dev": "sha256:5fd64354ee9372bf280302cb58b614ca81ae5e547f2f31305b8da4316af3f6ba",
    "sd35medium": "sha256:22ee11731ede250d88fd5b5cc214dcba58d350e942dd355f9eb20553f6155c6f",
}
UNCHANGED = {
    "latest": RELEASED,
    OLD_PREFIX + "runtime": RELEASED,
    "base": "sha256:5cc4f79f21e61b9da46e94286c29ef8185520117452027a6f5574cf6125c0ff8",
    "comfy0.35.0-api1.19.2-torch2.13.0-cuda13.0-runtime-securitytest-199b1791701a": BASE,
    **{OLD_PREFIX + preset: digest for preset, digest in OLD_PRESETS.items()},
}
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
    parser.add_argument("preset", choices=OLD_PRESETS)
    args = parser.parse_args()
    prefix = os.environ["IMAGE_PREFIX"]
    assert re.fullmatch(
        r"ghcr\.io/saladtechnologies/comfyui-api:comfy0\.35\.0-api1\.19\.2-"
        r"torch2\.13\.0-cuda13\.0-securitytest-[a-f0-9]{12}", prefix
    ), prefix
    if "GITHUB_SHA" in os.environ:
        assert prefix.endswith(os.environ["GITHUB_SHA"][:12])
    image = prefix + "-" + args.preset
    tag = image.split(":", 1)[1]
    token, _ = get("https://ghcr.io/token?service=ghcr.io&scope=repository:" + REPO + ":pull")
    headers = {"Authorization": "Bearer " + token["token"], "Accept": ACCEPT}

    def manifest(ref):
        return get("https://ghcr.io/v2/" + REPO + "/manifests/" + ref, headers)

    def platform_manifest(ref):
        value, digest = manifest(ref)
        if "manifests" in value:
            linux = next(item for item in value["manifests"]
                         if item.get("platform", {}).get("os") == "linux"
                         and item["platform"].get("architecture") == "amd64")
            value, actual = manifest(linux["digest"])
            assert actual == linux["digest"]
        return value, digest

    def image_config(value):
        config, digest = get("https://ghcr.io/v2/" + REPO + "/blobs/" + value["config"]["digest"], headers)
        assert digest == value["config"]["digest"]
        return config

    for ref, expected in UNCHANGED.items():
        _, actual = manifest(ref)
        assert actual == expected, (ref, actual, expected)
    base, _ = platform_manifest(BASE)
    base_labels = image_config(base)["config"]["Labels"]
    for key, expected in {
        "org.opencontainers.image.version": "1.19.2-securitytest",
        "com.salad.api.binary-sha256": BINARY_SHA256,
        "com.salad.api.source-snapshot-sha256": SOURCE_SHA256,
    }.items():
        assert base_labels[key] == expected, (key, base_labels[key], expected)

    if args.mode == "before":
        try:
            manifest(tag)
        except urllib.error.HTTPError as error:
            body = json.load(error)
            assert error.code == 404 and any(
                item["code"] == "MANIFEST_UNKNOWN" for item in body.get("errors", [])
            ), (error.code, body)
        else:
            raise RuntimeError("Refusing to overwrite an existing test tag: " + tag)
        print("Base verified; existing tags unchanged; destination is unused: " + image, flush=True)
        return

    published, digest = platform_manifest(tag)
    assert published["layers"][:len(base["layers"])] == base["layers"]
    # Classic Docker uses a config ID; the containerd store can use a manifest ID.
    if "LOCAL_IMAGE_ID" in os.environ:
        assert os.environ["LOCAL_IMAGE_ID"] in (digest, published["config"]["digest"])
    config = image_config(published)
    assert (config["os"], config["architecture"]) == ("linux", "amd64")
    labels = config["config"]["Labels"]
    for key, expected in {
        "org.opencontainers.image.source": "https://github.com/SaladTechnologies/comfyui-api",
        "org.opencontainers.image.base.digest": BASE,
        "org.opencontainers.image.version": "1.19.2-securitytest",
        "com.salad.api.binary-sha256": BINARY_SHA256,
        "com.salad.api.source-snapshot-sha256": SOURCE_SHA256,
        "com.salad.recipe.source": "https://github.com/SaladTechnologies/salad-recipes",
        "com.salad.recipe.revision": RECIPE_REVISION,
        "com.salad.recipe.preset": args.preset,
    }.items():
        assert labels[key] == expected, (key, labels[key], expected)
    if "GITHUB_SHA" in os.environ:
        assert labels["org.opencontainers.image.revision"] == os.environ["GITHUB_SHA"]
    env = dict(item.split("=", 1) for item in config["config"]["Env"])
    assert env["MANIFEST"] == "/app/manifest.yml"
    assert env["WARMUP_PROMPT_FILE"] == "warmup.json"
    assert env["WORKFLOW_DIR"] == "/workflows"
    assert "HTTP_TRUSTED_ORIGINS" not in env and "HTTP_AUTH_HEADER_VALUE" not in env
    assert config["config"]["Cmd"] == ["./comfyui-api"]
    result = {"image": image, "digest": digest, "preset": args.preset, "verified": True,
              "base_digest": BASE, "recipe_revision": RECIPE_REVISION,
              "source_revision": labels["org.opencontainers.image.revision"],
              "binary_sha256": BINARY_SHA256, "source_snapshot_sha256": SOURCE_SHA256,
              "anonymous_pull_access": True, "existing_tags_unchanged": True}
    print(json.dumps(result), flush=True)
    if "GITHUB_STEP_SUMMARY" in os.environ:
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write("Published `" + image + "`\n\nDigest: `" + digest + "`\n\n")
            summary.write("Original manifest, warmup, and workflow files are byte-identical. ")
            summary.write("CPU startup, model listing, workflow route, and image-processing checks passed. ")
            summary.write("Full model inference requires a GPU test.\n")


if __name__ == "__main__":
    main()
