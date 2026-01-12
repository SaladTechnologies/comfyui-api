ARG base=runtime
ARG pytorch_version=2.8.0
ARG cuda_version=12.6

FROM pytorch/pytorch:${pytorch_version}-cuda${cuda_version}-cudnn9-${base}

ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_PREFER_BINARY=1
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
RUN uv pip install --no-cache-dir --system comfy-cli "huggingface_hub[cli]"

WORKDIR /opt

ARG comfy_version=0.8.2

RUN git clone --depth 1 --branch v${comfy_version} https://github.com/comfyanonymous/ComfyUI.git

WORKDIR /opt/ComfyUI

ARG cuda_version=12.6

RUN uv pip install --no-cache-dir --system torchaudio --index-url https://download.pytorch.org/whl/cu${cuda_version//./}
RUN uv pip install --no-cache-dir --system -r requirements.txt

ENV COMFY_HOME=/opt/ComfyUI

RUN comfy --skip-prompt tracking disable
RUN comfy --skip-prompt set-default ${COMFY_HOME}

RUN git clone https://github.com/Comfy-Org/ComfyUI-Manager.git ./custom_nodes/ComfyUI-Manager
RUN uv pip install --system --no-cache-dir -r ./custom_nodes/ComfyUI-Manager/requirements.txt

ENV MODEL_DIR=${COMFY_HOME}/models
ENV OUTPUT_DIR=${COMFY_HOME}/output
ENV INPUT_DIR=${COMFY_HOME}/input
ENV CMD="comfy --workspace ${COMFY_HOME} launch -- --listen *"
ENV BASE=""

CMD ["bash", "-c", "comfy --workspace ${COMFY_HOME} launch -- --listen '*'"]