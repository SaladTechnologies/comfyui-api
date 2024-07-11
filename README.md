# comfyui-wrapper
A simple wrapper that facilitates using ComfyUI as a stateless API, either by receiving images in the response, or by sending completed images to a webhook

Download the latest version from the release page, and copy it into your dockerfile. Then, you can use it like this:

```dockerfile
COPY comfyui-wrapper .

CMD ["./comfyui-wrapper"]
```

The server will be available on port 3000 by default, but this can be customized with the `PORT` environment variable.