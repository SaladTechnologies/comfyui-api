# Core Flow Bug Analysis & Optimization Proposals

## 📝 Summary
This issue tracks potential bugs and optimization opportunities identified in the core ComfyUI API flow, specifically within `src/comfy.ts`, `src/prompt-handler.ts`, and `src/remote-storage-manager.ts`. Addressing these issues will improve system stability, prevent memory leaks, and ensure reliable error reporting.

## 🐛 Identified Issues

### 1. WebSocket Event Listener Memory Leak (High Priority)
- **Location**: `src/comfy.ts` -> `collectExecutionStats`
- **Problem**: The function adds `message` and `close` event listeners to the global `wsClient`. These listeners are only removed if the specific execution promise resolves or rejects (via `isExecutionSuccessMessage`, etc.).
- **Root Cause**: In `runPromptAndGetOutputs`, `Promise.race` is used between `historyPoll` and `executionStatsPromise`. If `historyPoll` completes first (which is a handled case), the `executionStatsPromise` is abandoned, but its internal event listeners are **never removed**.
- **Impact**: Accumulation of zombie event listeners on the single WebSocket connection. Each request that finishes via polling instead of WS adds a permanent listener, leading to memory leaks and CPU degradation as every subsequent message triggers all zombie listeners.
- **Proposed Fix**: Implement a cleanup mechanism (e.g., AbortSignal or a `.cancel()` method) for `collectExecutionStats` and call it in the `finally` block or when the race is won by the poller.

### 2. Unbounded Concurrent File Reads (High Priority)
- **Location**: `src/comfy.ts` -> `getPromptOutputs`
- **Problem**: The code iterates through all output files and pushes `fsPromises.readFile` promises into an array, then awaits `Promise.all`.
- **Root Cause**: No concurrency limit is applied.
- **Impact**: If a prompt generates a large number of files (e.g., 500+ frames for a video), this will trigger `EMFILE: too many open files` errors or cause massive memory spikes (OOM) by loading all buffers simultaneously.
- **Proposed Fix**: Use `p-limit` or a similar utility to restrict concurrent file reads to a safe number (e.g., 10-20).

### 3. Unreliable Webhook Delivery on Error (Medium Priority)
- **Location**: `src/prompt-handler.ts` -> `processPrompt`
- **Problem**: When `preprocessNodes` fails, the code calls `sendWebhook` (fire-and-forget) and immediately throws an error.
  ```typescript
  if (webhook_v2) {
      sendWebhook(webhook_v2, webhookBody, log, 2);
  }
  throw e;
  ```
- **Impact**: The immediate throw interrupts the execution flow. In serverless or containerized environments, the process might be frozen or destroyed before the async webhook request completes, causing the user to miss critical error notifications.
- **Proposed Fix**: `await` the `sendWebhook` call (with a short timeout) or use `Promise.allSettled` before throwing the error to ensure the network request is dispatched.

### 4. Potential Infinite Polling Loop (Medium Priority)
- **Location**: `src/comfy.ts` -> `HistoryEndpointPoller`
- **Problem**: The loop condition `this.currentTries < this.getMaxTries() || this.maxTries === 0` allows for infinite looping if `maxTries` is 0.
- **Impact**: If ComfyUI hangs (no result, no error), the poller will run forever, potentially leaking the connection/request handler.
- **Proposed Fix**: Enforce a global timeout (e.g., 1 hour) even when `maxTries` is 0.

## ✅ Action Plan

1.  [ ] **Fix Memory Leak**: Refactor `collectExecutionStats` to return a `cancel` function and ensure it's called in `runPromptAndGetOutputs`.
2.  [ ] **Limit Concurrency**: Install `p-limit` and apply it to file reading loops in `src/comfy.ts`.
3.  [ ] **Stabilize Webhooks**: Add `await` to error webhook sending in `src/prompt-handler.ts`.

---
*Created automatically by Trae AI Assistant*
