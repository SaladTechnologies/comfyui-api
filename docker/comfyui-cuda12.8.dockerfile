ARG base=runtime
FROM nvcr.io/nvidia/cuda:12.8.1-cudnn-${base}-ubuntu24.04
ENV DEBIAN_FRONTEND=noninteractive

RUN apt update -y && apt install -y \
    wget \
    curl \
    git \
    python3 \
    python3-pip \
    python3-venv \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN . /opt/venv/bin/activate

RUN pip install --upgrade pip
RUN pip install --pre torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/nightly/cu128
RUN pip install comfy-cli
WORKDIR /opt
ARG comfy_version=0.3.27
RUN git clone --depth 1 --branch v${comfy_version} https://github.com/comfyanonymous/ComfyUI.git
WORKDIR /opt/ComfyUI
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