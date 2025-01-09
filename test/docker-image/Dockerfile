FROM pytorch/pytorch:2.5.0-cuda12.1-cudnn9-devel
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
  curl \
  git \
  unzip \
  wget \
  libgl1 \
  libgl1-mesa-glx \
  libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

# Install comfy-cli, which makes it easy to install custom nodes and other comfy specific functionality.
RUN pip install --upgrade pip
RUN pip install comfy-cli
WORKDIR /opt
ARG comfy_version=0.3.10
RUN git clone --depth 1 --branch v${comfy_version} https://github.com/comfyanonymous/ComfyUI.git
WORKDIR /opt/ComfyUI
RUN pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu121
RUN pip install -r requirements.txt
ENV COMFY_HOME=/opt/ComfyUI
RUN comfy --skip-prompt tracking disable
RUN comfy --skip-prompt set-default ${COMFY_HOME}
ENV CMD="comfy --workspace ${COMFY_HOME} launch -- --listen *"
ENV BASE=""
ENV MODEL_DIR=${COMFY_HOME}/models
ENV OUTPUT_DIR=${COMFY_HOME}/output
ENV INPUT_DIR=${COMFY_HOME}/input
ENV WORKFLOW_DIR=/workflows

RUN comfy node registry-install comfyui-videohelpersuite
RUN comfy node registry-install comfyui-animatediff-evolved
RUN comfy node registry-install efficiency-nodes-comfyui
RUN comfy node registry-install comfyui-advanced-controlnet
RUN comfy node registry-install comfyui-cogvideoxwrapper

COPY poses ${INPUT_DIR}/poses
ENV STARTUP_CHECK_MAX_TRIES=100