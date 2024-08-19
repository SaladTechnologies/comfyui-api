# comfyui-wrapper
A simple wrapper that facilitates using ComfyUI as a stateless API, either by receiving images in the response, or by sending completed images to a webhook

Download the latest version from the release page, and copy it into your dockerfile. Then, you can use it like this:

```dockerfile
COPY comfyui-wrapper .

CMD ["./comfyui-wrapper"]
```

The server will be available on port 3000 by default, but this can be customized with the `PORT` environment variable.

The server hosts swagger docs at `/docs`, which can be used to interact with the API.

# Application Configuration Guide

This application uses environment variables for configuration. Below are the available options and their default values:

## Environment Variables

- `CMD`: Command to launch ComfyUI (default: "init.sh")
- `HOST`: Host to bind the wrapper server (default: "::")
- `PORT`: Port for the wrapper server (default: "3000")
- `DIRECT_ADDRESS`: Direct address for internal communication (default: "127.0.0.1")
- `COMFYUI_PORT_HOST`: Port for ComfyUI (default: "8188")
- `STARTUP_CHECK_INTERVAL_S`: Interval in seconds between startup checks (default: "1")
- `STARTUP_CHECK_MAX_TRIES`: Maximum number of startup check attempts (default: "10")
- `OUTPUT_DIR`: Directory for output files (default: "/opt/ComfyUI/output")
- `INPUT_DIR`: Directory for input files (default: "/opt/ComfyUI/input")
- `MODEL_DIR`: Directory for model files (default: "/opt/ComfyUI/models")
- `WARMUP_PROMPT_FILE`: Path to a JSON file containing a warmup prompt (optional)
- `WORKFLOW_MODELS`: Specify which models to include in workflows (default: "all")

## Configuration Details

1. The application will use `http://${DIRECT_ADDRESS}:${COMFYUI_PORT_HOST}` to communicate with ComfyUI.
2. The wrapper server will be accessible at `http://localhost:${PORT}`.
3. If `WARMUP_PROMPT_FILE` is specified, it must exist and contain valid JSON. The application will attempt to extract the checkpoint name from this file.
4. The `MODEL_DIR` is scanned for subdirectories. Each subdirectory is treated as a model category, and its contents are listed as available models.

## Model Configuration

Models are automatically detected from the `MODEL_DIR`. Each subdirectory in `MODEL_DIR` is considered a model category. The application creates an enumeration of all files in each category, which can be used for validation in the application.

## Workflow Models

The `WORKFLOW_MODELS` variable determines which workflow endpoints are available.
By default, it's set to "all", including all base model categories
If you want to only include models from a specific base model category, specify them in a comma separated list.
The available options are `sd1.5`, `sdxl`, and `flux`.
To specify stable diffusion 1.5 and stable diffusion xl workflows, you can set `WORKFLOW_MODELS` to `sd1.5,sdxl`.