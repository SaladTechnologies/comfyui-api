ARG base=runtime
ARG comfy_version=0.3.26
ARG pytorch_version=2.6.0
ARG cuda_version=12.4
FROM ghcr.io/saladtechnologies/comfyui-api:comfy${comfy_version}-torch${pytorch_version}-cuda${cuda_version}-${base}

ENV WORKFLOW_DIR=/workflows
ENV STARTUP_CHECK_MAX_TRIES=30

ARG api_version=1.8.2
ADD https://github.com/SaladTechnologies/comfyui-api/releases/download/${api_version}/comfyui-api .
RUN chmod +x comfyui-api

CMD ["./comfyui-api"]