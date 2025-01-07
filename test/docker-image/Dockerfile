FROM saladtechnologies/comfyui:comfy0.3.10-api1.7.0-base

RUN apt-get update && apt-get install -y \
  libgl1 \
  libgl1-mesa-glx \
  libglib2.0-0 && \
  rm -rf /var/lib/apt/lists/*

RUN comfy node registry-install comfyui-videohelpersuite
RUN comfy node registry-install comfyui-animatediff-evolved
RUN comfy node registry-install efficiency-nodes-comfyui
RUN comfy node registry-install comfyui-advanced-controlnet

RUN mkdir -p $MODEL_DIR/animatediff_models

# https://huggingface.co/wangfuyun/AnimateLCM/resolve/b78bbce/AnimateLCM_sd15_t2v.ckpt
COPY models/AnimateLCM_sd15_t2v.ckpt ${MODEL_DIR}/animatediff_models/

# https://civitai.com/models/4384/dreamshaper
COPY models/dreamshaper_8.safetensors ${MODEL_DIR}/checkpoints/

COPY models/openpose-sd1.5-1.1.safetensors ${MODEL_DIR}/controlnet/
COPY models/jump_V2.safetensors ${MODEL_DIR}/loras/
COPY models/vae-ft-mse-840000-ema-pruned.ckpt ${MODEL_DIR}/vae/


COPY poses $INPUT_DIR/