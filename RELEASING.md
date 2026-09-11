# Releasing ComfyUI API

The September 2026 update targets API **1.19.0**, ComfyUI **0.35.0**, PyTorch
**2.13.0**, CUDA **13.0**, TorchAudio **2.11.0**, and Comfy CLI **1.20.0**.

## Why this update is needed

The previous image defaults used ComfyUI 0.19.3. The latest stable ComfyUI release
checked on September 11, 2026 is [0.35.0, released September 9](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.35.0).
It includes container memory-limit handling and newer model/node support, along
with the fixes released since 0.19.3.

ComfyUI 0.28 introduced real-path containment checks for inputs. The wrapper's
cache symlinks fail those checks. The staging change follows the approach in
[PR #187](https://github.com/SaladTechnologies/comfyui-api/pull/187), with additional
handling for concurrent requests, normalized input paths, and atomic copies when
the cache and input directory are on different filesystems. Existing input
symlinks are repaired when reused. Model files still use symlinks.

[ComfyUI's installation guidance](https://github.com/Comfy-Org/ComfyUI/blob/v0.35.0/README.md#manual-install-windows-linux)
requires CUDA 13 or newer PyTorch builds for NVIDIA 20-series and newer GPUs and
recommends letting new PyTorch releases age for two weeks. PyTorch 2.14.0 was only
nine days old at this check, so this update uses 2.13.0/CUDA 13.0.
[TorchAudio 2.11 supports PyTorch 2.11 and later](https://docs.pytorch.org/audio/stable/installation.html).
The Dockerfile constrains the installed Torch packages so subsequent dependency
installation cannot silently change the versions in the image tag.

These CUDA 13 images require [NVIDIA driver 580 or newer](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)
and Turing or newer GPUs; [CUDA 13 libraries dropped Maxwell, Pascal, and Volta](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html#cufft-release-13-0).
Validate the target Salad GPU/driver pool and customer custom nodes before rollout.
Keep incompatible pools on their previous pinned images until a compatible image
has been separately built and validated.
Input hard links keep their bytes alive after cache eviction; copied inputs also
consume space outside `CACHE_DIR`. Account for `INPUT_DIR` storage in long-lived
containers; `LRU_CACHE_SIZE_GB` only manages the cache.

## Validate the candidate

Validation recorded September 11:

- TypeScript compilation and all **87 unit tests passed**.
- **56 integration tests passed** against the standalone binary and ComfyUI
  0.35.0 on an RTX 4060 Ti: image generation, HTTP/S3/Azure inputs and outputs,
  synchronous and webhook responses, format conversion, custom workflow endpoints,
  downloads, system events, and built-in MP4/FLAC output workflows.
- **15 integration tests were excluded**: 13 Hugging Face cases needing the test
  repositories/credentials, and two workflows that download additional external
  models. `HF_TOKEN` was not configured. These cases remain unvalidated.
- Both runtime and development base images, and the standalone API binary,
  built successfully. The development image passed package-version checks,
  PyTorch GPU execution, and compilation/execution of a CUDA kernel with `nvcc`.

The integration run exposed an existing Azure Blob download hang: its stream
completion handler returned the resolver instead of calling it. Downloads now use
the stream pipeline, which completes correctly and propagates stream errors. Four
unit regression cases and the Azure integration cases cover this fix.

The completed GPU tests used WSL2 with NVIDIA CDI support, a 4-CPU/12-GiB container
limit, and separate cache/input filesystems to exercise the input-copy fallback.

From a clean checkout of the release branch:

```sh
npm ci --ignore-scripts
npm run build
npm run unit-test
npm run build-binary

docker build -f docker/comfyui.dockerfile \
  -t comfyui-api-candidate:base docker
docker build -f docker/comfyui.dockerfile --build-arg base=devel \
  -t comfyui-api-candidate:devel docker
COMFYUI_TEST_IMAGE=comfyui-api-candidate:base \
  docker compose -f test/docker-compose.integration.yml up -d --build

npm test -- --testNamePattern='^(?!.*(?:HuggingFace|hf image|hf url|non-interrelated)).*$' \
  --testTimeout=120000 --hookTimeout=180000
```

Place the two DreamShaper checkpoints from `manifest.yml` in `cache/` first.
See [DEVELOPING.md](./DEVELOPING.md#testing-procedures) for ports, fixtures, and
the optional Hugging Face tests. The filtered command excludes authenticated HF
uploads and workflows that download additional external models. Run the full
`npm test` with the test account's HF credentials and access to those model URLs
to cover them. Exercise the customer workflows, including video/audio and any
custom nodes, against the candidate image on the deployment GPU types.

Stop only this test stack when done:

```sh
docker compose -f test/docker-compose.integration.yml down
```

## Publish the release artifacts

1. Push the reviewed branch, open a PR, and merge after CI and GPU validation:

   ```sh
   git push -u origin update/comfyui-0.35.0
   ```

2. Build and publish the ComfyUI base images from the merged `main`:

   ```sh
   gh workflow run build-comfy-base-images.yml --ref main \
     -f comfy_version=0.35.0 -f torch_version=2.13.0 -f cuda_version=13.0
   gh run list --workflow build-comfy-base-images.yml --limit 5
   gh run watch <base-build-run-id> --exit-status
   ```

   This publishes the versioned `runtime` and `devel` base images and updates
   `ghcr.io/saladtechnologies/comfyui-api:base`.

3. Run **Create Release**. It reads `package.json` and creates a **draft** release
   with the standalone Linux x64 binary:

   ```sh
   gh workflow run create-release.yml --ref main
   gh run list --workflow create-release.yml --limit 5
   gh run watch <release-run-id> --exit-status
   gh release view 1.19.0
   ```

   Review the draft's title, notes, tag/commit, and `comfyui-api` asset. The current
   workflow gets notes from the last merged PR, so edit those notes if needed.

4. Publish the draft through GitHub's Releases UI, or:

   ```sh
   gh release edit 1.19.0 --draft=false
   ```

   Publishing as a user triggers **Build API Docker Images**. If it does not run
   (for example, when publishing with a workflow's `GITHUB_TOKEN`), dispatch it:

   ```sh
   gh workflow run build-docker-images.yml --ref 1.19.0
   ```

   Watch the build finish. It publishes:

   ```text
   ghcr.io/saladtechnologies/comfyui-api:comfy0.35.0-api1.19.0-torch2.13.0-cuda13.0-runtime
   ghcr.io/saladtechnologies/comfyui-api:comfy0.35.0-api1.19.0-torch2.13.0-cuda13.0-devel
   ```

   This workflow also updates `:latest`. Complete candidate validation before
   publishing; consumers that rebuild or pull that alias can receive the update.

## Roll out on SaladCloud

Publishing GHCR images does not itself update running Salad container groups.
For groups using these images directly, deploy the versioned API image (preferably
its digest) to a staging group with the production manifest, GPU selection,
environment, storage configuration, and warmup workflow. For derived customer
images, update their `FROM`, rebuild, and test those images first.

Check `/health` and `/ready`, submit representative synchronous and webhook jobs,
verify uploaded results, and compare error rate, queue time, inference latency,
memory use, and startup time against the current deployment. Then update production
groups in batches using the validated image digest. Keep the previous image digest
and group configuration so rollback consists of redeploying that exact version.

## Open PRs at the September 11 check

There were 14 open PRs: the compatibility fix above and 13 Dependabot updates.
The dependency PRs are separate from this ComfyUI update and have not been merged.

| PR | Change |
| --- | --- |
| [#187](https://github.com/SaladTechnologies/comfyui-api/pull/187) | Stage inputs for ComfyUI >= 0.28 |
| [#184](https://github.com/SaladTechnologies/comfyui-api/pull/184) | sharp 0.34.5 → 0.35.0 |
| [#183](https://github.com/SaladTechnologies/comfyui-api/pull/183) | fast-uri 3.1.0 → 3.1.4 |
| [#182](https://github.com/SaladTechnologies/comfyui-api/pull/182) | brace-expansion 5.0.5 → 5.0.7 |
| [#181](https://github.com/SaladTechnologies/comfyui-api/pull/181) | ws 8.19.0 → 8.21.0 |
| [#180](https://github.com/SaladTechnologies/comfyui-api/pull/180) | tar 7.5.13 → 7.5.16 |
| [#179](https://github.com/SaladTechnologies/comfyui-api/pull/179) | form-data 4.0.5 → 4.0.6 |
| [#178](https://github.com/SaladTechnologies/comfyui-api/pull/178) | undici 7.25.0 → 7.28.0 |
| [#177](https://github.com/SaladTechnologies/comfyui-api/pull/177) | vite 7.3.2 → 7.3.5 |
| [#176](https://github.com/SaladTechnologies/comfyui-api/pull/176) | esbuild and vitest |
| [#172](https://github.com/SaladTechnologies/comfyui-api/pull/172) | uuid, @azure/identity, and svix |
| [#169](https://github.com/SaladTechnologies/comfyui-api/pull/169) | fast-xml-builder 1.1.5 → 1.2.0 |
| [#166](https://github.com/SaladTechnologies/comfyui-api/pull/166) | postcss 8.5.6 → 8.5.12 |
| [#165](https://github.com/SaladTechnologies/comfyui-api/pull/165) | fast-xml-parser and @aws-sdk/xml-builder |
