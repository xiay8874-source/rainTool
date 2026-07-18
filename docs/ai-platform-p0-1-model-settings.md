# P0-1 模型设置页重构 + Git/Draw.io P0 修复

> 本文档记录本次 P0 修复的改动范围、数据模型迁移、协议路由、安全契约，以及
> 升级/使用说明。改动只触及 AI 设置、Git 工作台首屏、AI Draw.io 启动生命周期，
> 不改变会话/附件/工具/MCP 既有契约。

## 1. 改动总览

| 领域 | 文件 | 变更 |
|---|---|---|
| 模型设置页 | `src/components/settings/ModelSettings.tsx` | **新增**：供应商侧栏 + 详情面板 + 模型列表，替换旧的 `SettingsDrawer` 弹窗 |
| AI 助手 | `src/components/tools/ai-assistant.tsx` | 移除 `SettingsDrawer`，改为打开 `ModelSettings` 页；挂载时 hydrate 供应商 |
| AI store | `src/store/ai.ts` | 新增 `suppliers` / `modelSettingsOpen` / `loadSuppliers` / `saveSupplier` / `setSupplierEnabled` / `deleteSupplier`；`loadProfiles` 仅保留 enabled |
| 类型 | `src/types/raintool.d.ts`、`electron/preload.ts` | 新增供应商 IPC API 类型 + preload 暴露 |
| AI 类型 | `electron/ai-platform/ai-types.ts` | 新增 `AiProtocol`、`AiSupplier`、`AiSupplierInput`；`AiModelProfile` 增 `supplierId/enabled/protocol`；`AI_PROFILE_SCHEMA_VERSION` → 2；TokenHub 默认常量 |
| 供应商仓库 | `electron/ai-platform/ai-supplier-repository.ts` | **新增**：CRUD + 启用/禁用 + TokenHub 首次播种 + 旧 profile 迁移去重 + 原子写 |
| Profile 仓库 | `electron/ai-platform/ai-model-profile-repository.ts` | 增 `supplierId/enabled/protocol`；`listEnabled/getEnabled` 排除禁用模型 + 禁用供应商的模型；读时合并供应商连接配置；v1/v2 schema 兼容 |
| Provider 注册表 | `electron/ai-platform/ai-provider-registry.ts` | 按协议路由：`openai-chat` → `provider.chat`，`openai-responses` → `provider.responses`，`anthropic-messages` → 原生 fetch SSE（无新依赖） |
| AI IPC | `electron/ai-platform/ai-ipc.ts` | 新增 `ai:supplier:list/upsert/delete/set-enabled/save`；`ai:supplier:save` 事务性保存（凭据先存，失败不留孤儿） |
| 引导 | `electron/ai-platform/index.ts` | 构造供应商仓库 + 注入 profile 仓库 + 迁移旧 profile + 首次播种 TokenHub 模型 |
| 运行时 | `electron/ai-platform/ai-runtime.ts` | `runLoop` + `proposeCommitMessage` 改用 `getEnabled`，禁用模型/供应商不可用 |
| Git 工作台 | `src/components/layout/Workspace.tsx` | **P0-2**：每个标签页外包 `ToolErrorBoundary`，chunk 加载失败显示可重试错误（根因：之前 tab 级 Suspense 无边界 → 永久「加载中…」） |
| AI Draw.io | `src/components/tools/ai-drawio.tsx` | **P0-3**：修复文档先于 `start()` 返回就加载完的竞态——直接进入 `ready`，不再卡在 `loading-document` 直到 15s 超时 |
| 测试 | `tests/ai-supplier-repository.test.mjs`、`tests/ai-model-disabled-gating.test.mjs`、`tests/ai-supplier-credential-atomic.test.mjs` | **新增**：迁移去重 / TokenHub 播种 / 禁用门控 / 事务性凭据保存 |

## 2. 数据模型

### 2.1 Supplier（供应商）

一个供应商 = 一份连接配置（base URL + 协议 + 加密凭据 + 启用开关），下挂一个或多个模型。

```ts
interface AiSupplier {
  id: string
  displayName: string
  providerId: 'openai-compatible' | 'ollama' | 'anthropic' | 'google'
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages'
  baseUrl?: string
  credentialKey: string          // 引用加密 vault，原始 key 永不落盘/回传
  enabled: boolean               // 禁用供应商 → 其下所有模型从 AI 助手/Git AI 排除
  createdAt: number
  updatedAt: number
}
```

存储路径：`userData/ai/suppliers.json`，原子写（temp + rename，mode 0600）。

### 2.2 Model Profile（模型条目）

profile 现在是供应商下的一个**模型**，不再独立承载连接配置：

```ts
interface AiModelProfile {
  // 既有字段...
  supplierId?: string            // P0-1：所属供应商
  enabled?: boolean              // P0-1：单模型启用开关（默认 true）
  protocol?: AiProtocol          // P0-1：可选的单模型协议覆盖（通常继承供应商）
}
```

profile schema `v1 → v2`：v1 profile 在读取时归一化（`enabled=true`、`protocol` 由 providerId 推导、`supplierId` 由迁移补上）。`profiles.json` 接受 v1 与 v2，写出为 v2。

### 2.3 读取时合并

`AiModelProfileRepository` 在构造后被注入 supplier 仓库引用。`get/getEnabled/list/listEnabled` 在返回 profile 前，按其 `supplierId` 查供应商并合并：`protocol = profile.protocol ?? supplier.protocol`、`baseUrl = supplier.baseUrl`、`credentialKey = supplier.credentialKey`（供应商独占连接配置）。供应商禁用时 `getEnabled/listEnabled` 返回 null/跳过，`get/list` 仍返回但 `enabled=false`（保留会话历史可解析名字）。

## 3. TokenHub 默认供应商

首次运行（`suppliers.json` 不存在或为空）自动播种：

- id: `supplier_tokenhub_default`
- displayName: `TokenHub`
- baseUrl: `http://127.0.0.1:15722/v1`
- protocol: `openai-chat`
- enabled: true
- 凭据：本地服务无需 key（`cred_tokenhub_default` 空槽）

同时（仅当完全没有任何 profile 时）播种 4 个默认模型：`GLM-5.2` / `AUTO` / `Logos` / `Multimodal-Chat`，全部挂在 TokenHub 供应商下。

播种幂等：已存在任何 supplier/profile 时不重建（用户删了默认就不重建）。

## 4. 旧 profile 迁移与去重

`initAiPlatform` 启动时执行 `migrateLegacyProfilesIntoSuppliers`：

- 对每个没有 `supplierId` 的 profile，调用 `supplierRepository.resolveSupplierForLegacyProfile`。
- **去重键**：`(providerId, baseUrl||'', credentialKey)`。共享这三个值的 profile 折叠进同一个供应商（它们本就指向同一端点、同一凭据）。
- **TokenHub 折叠**：`baseUrl === http://127.0.0.1:15722/v1` 的 profile 折进播种的 TokenHub 供应商，不产生重复。
- 迁移幂等：profile 已带有效 `supplierId` 则跳过。

这解决了旧「模型与凭据」弹窗反复添加同一端点导致的重复 profile 问题。

## 5. 协议路由

`AiProviderRegistry.streamChat` 按 profile 的有效协议分支：

| 协议 | 路径 | 说明 |
|---|---|---|
| `openai-chat` | `@ai-sdk/openai` `provider.chat(model)` + `streamText` | POST `/chat/completions`；兼容 Ollama / OpenRouter / TokenHub |
| `openai-responses` | `@ai-sdk/openai` `provider.responses(model)` + `streamText` | POST `/responses`（新版 OpenAI 接口） |
| `anthropic-messages` | 原生 fetch SSE → `{baseUrl}/v1/messages` | 不引入 `@ai-sdk/anthropic` 依赖；解析 `content_block_delta` → text-delta，`message_stop` → completed |

有效协议解析顺序：`profile.protocol` > 供应商 protocol（读取时合并）> providerId 默认（`anthropic` → `anthropic-messages`，其余 → `openai-chat`）。

三种协议都遵守同一终态契约：`streamChat` 只发 `text-delta`，返回 `AiStreamOutcome`（completed/failed/aborted），**终态由 runtime 独占**。原始 key 仅出现在请求头（`Authorization` 或 `x-api-key`），绝不进入事件/日志/错误（错误经 `redactSecrets` 脱敏）。

## 6. 安全契约（不变 + 加强）

- 原始 key 永不落盘（safeStorage 加密）、永不回传渲染层、永不进日志/会话 JSON。
- 渲染层只见 `AiCredentialStatus`（掩码预览）。
- **P0-1 加强**：`ai:supplier:save` 事务性保存——凭据先存，成功才 upsert 供应商；加密不可用时返回 `{ ok: false, reason: 'encryption-unavailable' }` 且**不写供应商**，杜绝孤儿供应商引用不存在的凭据。
- TokenHub-URL 供应商 upsert 折叠进播种 id，杜绝重复 TokenHub 记录。
- 禁用模型/供应商：`runLoop` 与 `proposeCommitMessage` 改用 `getEnabled`；AI 助手下拉用 `listEnabled`；禁用模型不得被 AI 助手/Git AI 使用。

## 7. Git 工作台首屏（P0-2）

**症状**：打开 Git 工作台永久「加载中…」。

**根因**：`Workspace.tsx` 每个标签页的 `<Suspense fallback="加载中…">` 外层无 ErrorBoundary。当工具的动态 chunk 加载失败（打包后缺 chunk、Monaco worker 解析失败、网络抖动），`lazy()` 抛出的 rejection 无边界捕获，React 把该标签页永久留在 fallback。

**修复**：新增 `TabBoundary` 包裹每个标签页的 `Suspense`，复用既有 `ToolErrorBoundary`。重试时清掉该工具的 `toolCache` 并 bump key，`loadTool` 重新发起动态 import。任何工具的 chunk 加载失败现在都显示「重试」按钮而非永久卡死。

Monaco Diff 编辑器自身的隔离（`git-workbench/diff-pane.tsx` 懒加载 + `ToolErrorBoundary`）保持不变——首屏 shell 同步渲染、Monaco 按需加载、加载失败可重试。

## 8. AI Draw.io 启动生命周期（P0-3）

**症状**：生产环境 AI Draw.io 一直「启动中/加载中」。

**根因**：文档加载 effect 在挂载时即发起（不等 `start()` 返回）。若文档在 `start()` 等待期间已加载完成并写入 `documentRef`，`start()` 成功后把 phase 置为 `loading-document`，但文档 effect 的 `.then` 不会重跑（依赖未变），phase 卡在 `loading-document` 直到 15s 超时才报错。

**修复**：`start()` 成功分支检查 `documentRef.current`——有值则直接进入 `ready`（iframe 渲染后由 `FRAME_READY_TIMEOUT` 兜底桥接就绪），无值才进 `loading-document`。

既有有界超时保持不变：`START_TIMEOUT_MS=35s`、`DOCUMENT_LOAD_TIMEOUT_MS=15s`、`FRAME_READY_TIMEOUT_MS=20s`。任何阶段超时都翻转为可重试错误（按 `retry` 判别器分派重试路径）。

## 9. 升级与使用

### 9.1 老用户升级

升级后首次启动自动迁移：

1. 播种 TokenHub 默认供应商（若 `suppliers.json` 不存在）。
2. 既有 profile 按 `(providerId, baseUrl, credentialKey)` 去重归入供应商；TokenHub-URL profile 折进默认供应商。
3. `profiles.json` schema 升到 v2（字段补全，向后兼容 v1 读取）。
4. 若原本无任何 profile，播种 TokenHub 4 个默认模型。

凭据不动：`credentials.json`（safeStorage 密文）原样保留，profile 的 `credentialKey` 仍指向原凭据。

### 9.2 使用

- AI 助手侧栏底部「⚙ 模型设置」打开全页设置。
- 左侧供应商列表：开关切换启用/禁用；「+ 添加供应商」新建。
- 右侧详情：编辑供应商（显示名/Provider/协议/Base URL/API Key）、模型列表（添加/启用切换/删除）。
- 禁用供应商或单模型后，该模型立即从 AI 助手下拉与 Git「生成提交说明」中排除（运行时 `getEnabled` 兜底）。

### 9.3 协议选择

- TokenHub / Ollama / OpenRouter / 任意 OpenAI 兼容端点 → `openai-chat`。
- OpenAI 新版 Responses 接口 → `openai-responses`。
- Anthropic 原生（含 Claude）→ `anthropic-messages`（Base URL 默认 `https://api.anthropic.com`，可指向代理）。

## 10. 验证命令

> 注：本次改动因执行环境沙箱限制无法在会话内运行；以下命令需在仓库根目录手动执行。

```bash
# 类型检查
npm run build        # tsc -b && vite build

# AI 平台测试（含新增供应商/禁用门控/事务性保存）
npm run test:ai

# Git 工作台测试
npm run test:git

# 图纸 / Draw.io 测试
npm run test:diagrams

# 打包验证
npm run dist
npm run verify:package:ai
```
