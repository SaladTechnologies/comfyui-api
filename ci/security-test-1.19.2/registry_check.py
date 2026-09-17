"""Read-only registry verification for the temporary security image publication."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

REPOSITORY = "saladtechnologies/comfyui-api"
BASE = "sha256:5cc4f79f21e61b9da46e94286c29ef8185520117452027a6f5574cf6125c0ff8"
RELEASED = "sha256:38dc1b6bd1b2adde1afeec689e42128a62daf429cce3ca5bcdcd6ae771c4bc12"
ACCEPT = ",".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])
UNCHANGED = {
    "base": BASE,
    "latest": RELEASED,
    "comfy0.35.0-api1.19.1-torch2.13.0-cuda13.0-runtime": RELEASED,
}


def main():
    mode = sys.argv[1]
    assert mode in ("before", "after")
    output = Path(os.environ["ARTIFACT_DIR"])
    metadata = json.loads((output / "build-metadata.json").read_text())
    image = metadata["image"]
    assert image.startswith("ghcr.io/" + REPOSITORY + ":")
    tag = image.split(":", 1)[1]
    assert re.fullmatch(r"comfy0\.35\.0-api1\.19\.2-torch2\.13\.0-cuda13\.0-runtime-securitytest-[a-f0-9]{12}", tag), tag
    with urllib.request.urlopen("https://ghcr.io/token?service=ghcr.io&scope=repository:" + REPOSITORY + ":pull", timeout=45) as response:
        bearer = json.load(response)["token"]
    headers = {"Authorization": "Bearer " + bearer, "Accept": ACCEPT}

    def get(path):
        request = urllib.request.Request("https://ghcr.io/v2/" + REPOSITORY + "/" + path, headers=headers)
        with urllib.request.urlopen(request, timeout=45) as response:
            data = response.read()
        return json.loads(data), "sha256:" + hashlib.sha256(data).hexdigest()

    def manifest(ref):
        return get("manifests/" + ref)

    def platform_manifest(ref):
        value, digest = manifest(ref)
        if "manifests" in value:
            linux = next(item for item in value["manifests"]
                         if item.get("platform", {}).get("os") == "linux"
                         and item["platform"].get("architecture") == "amd64")
            value, _ = manifest(linux["digest"])
        return value, digest

    for ref, expected in UNCHANGED.items():
        _, actual = manifest(ref)
        assert actual == expected, (ref, actual, expected)

    if mode == "before":
        try:
            manifest(tag)
        except urllib.error.HTTPError as error:
            body = json.load(error)
            assert error.code == 404 and any(item["code"] == "MANIFEST_UNKNOWN" for item in body.get("errors", [])), (error.code, body)
        else:
            raise RuntimeError("Refusing to overwrite an existing test tag: " + tag)
        print("Release tags unchanged; test tag is unused: " + image, flush=True)
        return

    published, digest = platform_manifest(tag)
    # Docker's classic store identifies an image by its config; containerd uses
    # the manifest/index digest. Verify either representation against the registry.
    assert metadata["local_image_id"] in (digest, published["config"]["digest"]), (digest, metadata["local_image_id"])
    base, _ = platform_manifest(BASE)
    assert published["layers"][:len(base["layers"])] == base["layers"]
    assert len(published["layers"]) == len(base["layers"]) + 1
    config, _ = get("blobs/" + published["config"]["digest"])
    assert (config["os"], config["architecture"]) == ("linux", "amd64")
    labels = config["config"]["Labels"]
    for key, expected in {
        "org.opencontainers.image.source": "https://github.com/SaladTechnologies/comfyui-api",
        "org.opencontainers.image.revision": metadata["source_revision"],
        "org.opencontainers.image.version": "1.19.2-securitytest",
        "org.opencontainers.image.base.digest": BASE,
        "com.salad.api.binary-sha256": metadata["binary_sha256"],
        "com.salad.api.source-snapshot-sha256": metadata["source_snapshot_sha256"],
    }.items():
        assert labels[key] == expected, (key, labels[key], expected)
    env = dict(item.split("=", 1) for item in config["config"]["Env"])
    assert env["WORKFLOW_DIR"] == "/workflows"
    assert "HTTP_TRUSTED_ORIGINS" not in env and "HTTP_AUTH_HEADER_VALUE" not in env
    assert config["config"]["Cmd"] == ["./comfyui-api"]
    for test_mode in ("isolated", "public"):
        report = json.loads((output / (test_mode + "-smoke.json")).read_text())
        assert report["cpu_smoke"] == "passed" and report["api"] == "1.19.2"
    result = {"image": image, "digest": digest, "source_revision": metadata["source_revision"],
              "source_snapshot_sha256": metadata["source_snapshot_sha256"], "binary_sha256": metadata["binary_sha256"],
              "registry_verified": True, "unchanged_tags": UNCHANGED, "gpu_inference": "not_run"}
    (output / "publication.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)
    if "GITHUB_STEP_SUMMARY" in os.environ:
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write("Published test image: `" + image + "`\n\nDigest: `" + digest + "`\n\n")
            summary.write("Unit tests and container CPU/security/download checks passed. GPU inference still needs a deployment test.\n\n")
            summary.write("The main branch, latest tag, and releases were not updated.\n")


if __name__ == "__main__":
    main()
