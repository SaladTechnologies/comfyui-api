# ComfyUI API - ComfyUI 的无状态可扩展 API 封装（中文全文）

![Version](https://img.shields.io/badge/version-1.15.2-blue)
![License](https://img.shields.io/badge/license-MIT-green)

一个轻量封装，使 [ComfyUI](https://github.com/comfyanonymous/ComfyUI/) 以无状态 API 运行：可直接返回输出，或通过 Webhook/AMQP 事件进行异步交付。

## 🎉 v1.15.2 更新内容

AMQP 服务注册与心跳 —— 在 v1.15.0 的统一 AMQP 事件架构之上，增强“就绪判断”与“注册重试”，并完善通道状态日志：

- ✅ 服务注册：启动发布 `service.instance.register`（支持指数退避重试）
- ✅ 周期心跳：默认每 5 秒发布 `service.instance.heartbeat`（`HEARTBEAT_INTERVAL` 可配置）
- ✅ 优雅注销：进程退出发布 `service.instance.unregister`
- ✅ 公平分发：任务消费者保留 `prefetch(1)`，确保多实例负载均衡

影响：

- 结果事件为持久化；心跳为瞬态；注册/注销持久化
- 提升注册可靠性与线上排障可观测性

详见 `src/service-registry.ts` 与 `src/amqp-client.ts`。

## 主要特性（摘要）
- 完整 ComfyUI 支持：兼容 `/prompt` API，支持自定义节点与工作流
- 无状态设计：可横向扩展，配合健康/就绪探针
- 同步/异步：直接返回或通过 Webhook/AMQP 交付
- AMQP 事件：统一发布进度与结果事件，支持多实例负载均衡
- 模型管理：动态下载与缓存、可选 LRU
- 存储后端：S3/Azure Blob/HTTP/HF 等模块化输出
- Swagger 文档：内置 `/docs`

## 配置要点（AMQP）
- 环境变量：
  - `AMQP_URL` 或 `AMQP_HOST/PORT/USER/PASS/VHOST`
  - `AMQP_EXCHANGE_TOPIC=runnode.comfyui.topic`
  - `HEARTBEAT_ENABLED=true`
  - `HEARTBEAT_INTERVAL=5000`
  - `INSTANCE_GPU_VRAM=20G|40G|70G`

## 运行与构建
- 二进制构建：`./build-binary`
- 运行时查看日志，确认 `Instance registered` 与 `Heartbeat started`

## 参考
- `src/service-registry.ts`
- `src/amqp-client.ts`
- `src/server.ts`

---
> 许可：MIT；依赖基本为 MIT/Apache 2.0；ComfyUI 本体 GPL-3.0。
## 下载与使用

可使用 [预构建 Docker 镜像](#prebuilt-docker-images)，或自行构建。

从 Release 页面下载最新版本，复制到现有 ComfyUI Dockerfile 中。基础镜像示例见 [docker](./docker) 目录，常见模型的示例 Dockerfile 可参见 [SaladCloud Recipes Repo](https://github.com/SaladTechnologies/salad-recipes/tree/master/src)。

在自行的 Dockerfile 中加入 comfyui-api：

```dockerfile
# 使用目标版本
ARG api_version=1.14.19

# 下载并赋权
ADD https://github.com/SaladTechnologies/comfyui-api/releases/download/${api_version}/comfyui-api .
RUN chmod +x comfyui-api

# 以 comfyui-api 启动，子进程中运行 ComfyUI
CMD ["./comfyui-api"]
```

默认端口 `3000`，可用 `PORT` 环境变量修改。内置 Swagger 文档在 `/docs`。

## 特性

- **完整 ComfyUI 能力**：兼容 `/prompt` API，支持任何工作流
- **已验证模型/工作流**：SD1.5、SDXL、SD3.5、Flux、AnimateDiff、LTX Video、Hunyuan Video、CogVideoX、Mochi Video、Cosmos 1.0 等
- **无状态**：可水平扩展
- **Swagger 文档**：`/docs`
- **“同步”模式**：直接返回 base64 图片
- **异步 Webhook**：工作流完成回调
- **AMQP 支持**：通过队列提交任务与接收事件
- **流式响应**：SSE 实时进度
- **模型管理**：API 动态下载
- **媒体转换**：图片转视频/音频
- **压缩上传**：zip/tar
- **签名 URL**：S3/Azure Blob
- **自定义节点**：自动导入 sampler/scheduler
- **模块化存储后端**：S3/HTTP/HF/Azure Blob
- **预热工作流**：启动预热与就绪
- **PNG/JPEG/WebP 输出**：`sharp` 参数支持
- **探针**：`/health`、`/ready`
- **动态工作流端点**：`/workflows` 自动挂载
- **自带模型/扩展**：`/opt/ComfyUI/`
- **动态模型加载**：模型节点 URL 自动下载缓存
- **执行统计**：响应携带详尽时序与指标
- **SaladCloud 支持**：管理删除成本与镜像限制
- **单一二进制**：零依赖运行
- **Websocket 事件转 Webhook**：进度事件转发
- **友好许可**：MIT；依赖为 MIT/Apache 2.0；ComfyUI GPL-3.0

## 完整 ComfyUI 支持

前置 ComfyUI，调用其 `/prompt` API 执行工作流。排队前会下载输入资源，覆盖 `filename_prefix` 以确保唯一文件名。完成后根据请求返回响应/发送 webhook/上传到 S3。

## 无状态 API

服务器不保存跨请求状态，便于水平扩展。可配置预热工作流与 Swagger 文档。

### 请求格式

`POST /prompt`，JSON 包含工作流图与可选参数（webhook、S3、转码等）。示例见英文原文同段落。

### 响应格式

异步请求（使用 webhook 或上传 `async=true`）返回 `202 Accepted`；同步请求在完成后返回 `200 OK`，包含 `images/filenames/stats`。示例见英文原文。

### 示例用法

- Base64 响应、Webhook + Base64、S3 返回/回调、Azure Blob 返回/回调示例同英文原文。

## 模型清单（Manifest）

支持 JSON/YAML 清单自动下载模型与安装扩展，路径由 `MANIFEST` 或 `MANIFEST_JSON` 提供，优先使用 `MANIFEST_JSON`。格式与流程同英文原文。

## 下载行为

缓存目录（默认 `~/.cache/comfyui-api`），按 URL 哈希命名并软链到目标路径；S3/HF/Azure/HTTP 下载逻辑与重入控制同英文原文。

## LRU 缓存

`LRU_CACHE_SIZE_GB` 控制缓存目录大小，超限清理 LRU 文件；下载完成后计算容量，临时可能超过上限。

## 模块化存储后端

支持 S3/HF/Azure/HTTP 下载与上传；`async` 控制异步上传；并发上传时后者接管（保留最新输出）。配置与示例同英文原文。

## 图像到图像工作流

支持输入图片进行处理，示例同英文原文。

## 动态模型加载

模型节点中提供 URL，执行前自动下载与缓存，适合逐请求不同模型（如人像 LoRA）。

## 模型管理

`POST /models` 动态下载模型，示例与参数说明同英文原文。

## 服务端图像处理

`sharp` 转码配置（JPEG/WebP/视频/音频选项）详见英文原文；不配置默认 PNG。

## 探针

`/health` 与 `/ready` 行为与 `MAX_QUEUE_DEPTH` 说明同英文原文。

## API 配置指南

环境变量表、K8s 代理变量、详细配置说明与注意事项同英文原文。

## 同步与 Webhook 使用

Webhook v2（签名）、Legacy Webhook 行为、校验示例（Node/Python）同英文原文。

## AMQP 支持

连接配置、任务输入队列（`q.gpu.*/q.instance.*`）、事件输出 Topic Exchange（事件信封、路由键、绑定示例、事件数据示例）、系统事件与完整示例同英文原文。

## Streaming Responses（SSE）

事件类型、示例、系统事件（`progress_state` 等）、环境变量订阅与元数据说明同英文原文。

## 预构建镜像

镜像地址、Tag 模式与内置工具说明同英文原文。

## SaladCloud 注意事项

网关超时与镜像大小限制说明同英文原文。

## 自定义工作流

动态加载工作流端点，开发指南链接同英文原文。

## 贡献指南

欢迎贡献；开发与测试指南、问题反馈建议同英文原文。

## 架构

基于 Fastify；前置 ComfyUI 提供 REST API。架构图见 `ComfyUI API Diagram.png`。
