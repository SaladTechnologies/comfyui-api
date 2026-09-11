ARG base=runtime
ARG pytorch_version=2.13.0
ARG cuda_version=13.0

FROM pytorch/pytorch:${pytorch_version}-cuda${cuda_version}-cudnn9-${base}

ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_PREFER_BINARY=1
# Recent PyTorch images use Ubuntu's system Python. Package changes here are
# confined to the image; keep using that interpreter and its CUDA Torch build.
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV UV_BREAK_SYSTEM_PACKAGES=1
ENV CMAKE_BUILD_PARALLEL_LEVEL=8

RUN apt-get update && apt-get upgrade -y && apt-get install -y \
  curl \
  git \
  unzip \
  wget \
  && apt clean -y && rm -rf /var/lib/apt/lists/*

# Install comfy-cli, which makes it easy to install custom nodes and other comfy specific functionality.
SHELL ["/bin/bash", "-c"]

RUN pip install --no-cache-dir --upgrade pip
RUN pip install --no-cache-dir uv
RUN uv pip install --no-cache-dir --system "comfy-cli==1.20.0" "huggingface_hub[cli]"

WORKDIR /opt

ARG comfy_version=0.35.0

RUN git clone --depth 1 --branch v${comfy_version} https://github.com/Comfy-Org/ComfyUI.git

WORKDIR /opt/ComfyUI

ARG cuda_version=13.0
ARG torchaudio_version=2.11.0

# TorchAudio 2.11 uses the stable ABI and supports PyTorch 2.11 and later.
# Constrain the base's Torch stack so dependency resolution cannot change the
# versions advertised by the image tag.
RUN python -c 'import importlib.metadata as m; print("\n".join(f"{p}=={m.version(p)}" for p in ("torch", "torchvision")))' > /opt/pytorch-constraints.txt
RUN uv pip install --no-cache-dir --system -c /opt/pytorch-constraints.txt "torchaudio==${torchaudio_version}" --index-url https://download.pytorch.org/whl/cu${cuda_version//./}
RUN python -c 'import importlib.metadata as m; print("torchaudio==" + m.version("torchaudio"))' >> /opt/pytorch-constraints.txt
RUN uv pip install --no-cache-dir --system -c /opt/pytorch-constraints.txt -r requirements.txt

ENV COMFY_HOME=/opt/ComfyUI

RUN comfy --skip-prompt tracking disable
RUN comfy --skip-prompt set-default ${COMFY_HOME}

RUN git clone https://github.com/Comfy-Org/ComfyUI-Manager.git ./custom_nodes/ComfyUI-Manager
RUN uv pip install --system --no-cache-dir -c /opt/pytorch-constraints.txt -r ./custom_nodes/ComfyUI-Manager/requirements.txt

ENV MODEL_DIR=${COMFY_HOME}/models
ENV OUTPUT_DIR=${COMFY_HOME}/output
ENV INPUT_DIR=${COMFY_HOME}/input
ENV CMD="comfy --workspace ${COMFY_HOME} launch -- --listen *"
ENV BASE=""

CMD ["bash", "-c", "comfy --workspace ${COMFY_HOME} launch -- --listen '*'"]
