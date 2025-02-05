ARG base=runtime
ARG pytorch_version=2.6.0
ARG cuda_version=12.4
FROM pytorch/pytorch:${pytorch_version}-cuda${cuda_version}-cudnn9-${base}
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
  curl \
  git \
  unzip \
  wget \
  && rm -rf /var/lib/apt/lists/*

# Install comfy-cli, which makes it easy to install custom nodes and other comfy specific functionality.
RUN pip install --upgrade pip
RUN pip install comfy-cli
WORKDIR /opt
ARG comfy_version=0.3.13
RUN git clone --depth 1 --branch v${comfy_version} https://github.com/comfyanonymous/ComfyUI.git
WORKDIR /opt/ComfyUI
RUN pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu121
RUN pip install -r requirements.txt
ENV COMFY_HOME=/opt/ComfyUI
RUN comfy --skip-prompt tracking disable
RUN comfy --skip-prompt set-default ${COMFY_HOME}
ENV MODEL_DIR=${COMFY_HOME}/models
ENV OUTPUT_DIR=${COMFY_HOME}/output
ENV INPUT_DIR=${COMFY_HOME}/input
ENV CMD="comfy --workspace ${COMFY_HOME} launch -- --listen *"
ENV BASE=""

CMD ["comfy", "--workspace", "${COMFY_HOME}", "launch", "--", "--listen", "*"]