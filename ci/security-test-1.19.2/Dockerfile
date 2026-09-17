FROM ghcr.io/saladtechnologies/comfyui-api@sha256:5cc4f79f21e61b9da46e94286c29ef8185520117452027a6f5574cf6125c0ff8

ENV WORKFLOW_DIR=/workflows
ENV STARTUP_CHECK_MAX_TRIES=30

COPY --chmod=755 comfyui-api /opt/ComfyUI/comfyui-api

CMD ["./comfyui-api"]
