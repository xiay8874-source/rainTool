# AI Platform — P2 升级指引（Context Vault + 只读 Artifacts）

本文档是 P2 落地后的升级/交接指引，覆盖：架构与数据边界、Context Vault 生命周期、附件预算与敏感内容行为、Artifact 只读与密钥拒绝策略、JSON 工作台集成、公共 IPC/preload 契约、测试命令，以及移交 P3 的已知约束。

P2 在 P1（Provider/会话/隐私闸）之上构建应用层的上下文金库与只读产物，**不引入**工具调用、MCP、Agent loop、Git 写回、commit/push。所有新增能力都以"显式选择 + fail-closed + 不持久化原文"为不变式。

---

## 1. 架构与数据边界

```
renderer (untrusted)                main (trusted)                   provider (outbound)
─────────────────────              ─────────────────                ───────────────────
AttachmentChips (meta only)  ──►  AiContextVault                   AiRuntime ──► streamChat
  ingestAttachment(source,title,text)  │  in-memory payload map        │
    └─ ai:context:ingest ──────►       │  (raw text ONCE, then gone)   │
                                       │                               ├─ getMetaForSend(id) → null for placeholder
ArtifactsDrawer (read-only)  ──►  AiArtifactRepository              │
  aiArtifactCreate/List/Get/Delete     │  <userData>/ai/artifacts/      │
                                       │  one JSON file per artifact    │
startRun(message)            ──►  ai:run:start                       │
  attachmentIds[] (explicit only)      │  validateIds (reject unknown/  │
                                       │    invalid/oversize/placeholder)│
                                       └─ gateContext(attachments) ────► system prompt
                                            blocked → failed terminal      (no provider call)
```

**不变式（与 P1 安全模型一致）**：

- 原始密钥永不进入 renderer、日志、会话 JSON、错误或导出。
- `safeStorage.isEncryptionAvailable()` 为 false 时禁用已存凭据，无明文回退。
- 无工具调用、无 MCP client/server、无 Agent loop、无 Git 操作、无组件写回、无通用文件系统 API、无 shell/命令工具、无子 agent、UI 中无 provider key。
- 附件原始文本仅经 `ai:context:ingest` IPC **一次性**从可信 renderer 送入主进程；之后**永不回传 renderer、永不记日志、永不落盘**。
- 受限内容阻断出网 fail-closed，给出安全的模型/UI 原因，绝不持久化或记录原始受限数据。
- Artifact 是建议/预览，**无 apply/writeback 动作**。

---

## 2. Context Vault 生命周期

`AiContextVault`（`electron/ai-platform/ai-context-vault.ts`）是主进程内存中的附件 payload 存储。元数据可持久化，**原始 payload 永不持久化**。

### 2.1 ingest

```
ingest(input: AiAttachmentInput, ttlMs?): AiAttachmentMeta
```

- 原始文本经 `ai:context:ingest` **一次性**进入主进程，存入内存 payload map，带 TTL（默认 30 分钟）。
- 返回的 `AiAttachmentMeta` 含 `id`、`byteSize`、`tokenEstimate`、`sensitivity`、`restrictionReason?`、`expiresAt`、`storage`、`payloadAvailable: true`。**不含原始文本**。
- `classifySensitivity(text)` 在 ingest 时判定：`.env` 赋值 / PEM 私钥 / AWS AKIA / AWS secret → `sensitivity: 'restricted'`，附安全 reason（不含原始密钥）。

### 2.2 TTL / 过期

- 到期 payload 在访问时惰性清除（`getText`/`getMeta` 返回 `null`）。
- 默认 `AI_CONTEXT_DEFAULT_TTL_MS = 30 * 60 * 1000`（30 分钟）。

### 2.3 cancel / terminal / quit

- **cancel**：`clearForRun(ids)` 清除该运行选中的 payload（未选中的保留）。
- **terminal**（`finishRun`）：运行结束后清除该运行用过的 payload，renderer 端 `completed`/`failed`/`cancelled` 事件清空 `attachments: []`（chip 已失效）。
- **quit**：`main.ts` 在 `before-quit` 调用 `getAiPlatform()?.clearContextVault()`（在 `cancelAll` 之后），清空全部内存 payload。

### 2.4 restart placeholder（metadata-only）

- `storage: 'metadata-only'` 的附件：payload 仍在内存（ephemeral 性质），但其**元数据**写入 `<userData>/ai/context-metas.json`（不含原文）。
- 重启后新 `AiContextVault` 实例读取元数据索引，占位符以 `payloadAvailable: false` 出现在 `list()` 中。
- 占位符行为：`getText(id) → null`、`getMeta(id) → 占位符（payloadAvailable:false）`、`getMetaForSend(id) → null`（运行时防御）、`validateIds([id]) → { ok: false, reason: '...失效...' }`。
- ephemeral（默认）附件**不**写元数据索引，重启后从 `list()` 消失。

### 2.5 防御层

- `getMetaForSend(id)`：运行时专用，对占位符返回 `null`（payload 不可用就不送）。
- `validateIds(ids)`：IPC 边界用，拒绝未知/非法/占位符 id。
- `eligibilityReason({ attachments })`：renderer 闸，任何 `payloadAvailable:false` chip → `unavailable-attachments` 阻断（见 §4.3）。

---

## 3. 附件预算行为

`AiContextBudget`（`electron/ai-platform/ai-context-budget.ts`，纯模块）。

### 3.1 常量（`ai-context-types.ts`）

| 常量 | 值 | 含义 |
|---|---|---|
| `AI_CONTEXT_BUDGET_TOKENS` | 8 000 | 每次运行附件总 token 上限 |
| `AI_CONTEXT_BUDGET_BYTES` | 64 000 | 每次运行附件总字节上限 |
| `AI_CONTEXT_MAX_ATTACHMENT_BYTES` | 32 000 | 单附件字节上限 |
| `AI_CONTEXT_MAX_ATTACHMENT_TOKENS` | 4 000 | 单附件 token 上限 |
| `AI_CONTEXT_DEFAULT_TTL_MS` | 30 min | 默认 TTL |
| `AI_CONTEXT_MAX_ATTACHMENTS_PER_RUN` | 8 | 每次运行附件数上限 |

### 3.2 token 估算

`estimateTokens(text) = max(1, ceil(utf8Bytes(text) / 4))`——确定性，无网络。

### 3.3 gateContext(attachments)

返回 `AiContextGateResult`：

- `normal` 附件在预算内 → `ok`，组装 `contextText`（`[附加上下文]\n--- 标题 ---\n文本`）拼入 system prompt。
- `restricted` 附件 → `blocked`，`blockReason` 为安全 reason，**不调用 provider**，运行时产出 deferred `failed` 终端。
- 单附件超 `MAX_ATTACHMENT_TOKENS` → `rejected-oversize`，不纳入。
- 总额超预算 → 后续附件**截断**到剩余预算（不静默丢弃，UI 体现截断）。

---

## 4. 敏感内容行为

`AiSensitivityScanner`（`electron/ai-platform/ai-sensitivity-scanner.ts`，纯模块）。

### 4.1 classifySensitivity(text)

检测模式（fail-closed，宁可误拦）：

| 模式 | 正则 | reason |
|---|---|---|
| PEM 私钥块 | `-----BEGIN (RSA\|EC\|DSA\|OPENSSH\|PGP )?PRIVATE KEY-----` | 检测到 PEM 私钥标记 |
| `.env` 赋值 | `^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*(?:KEY\|TOKEN\|SECRET\|PASSWORD\|PASSWD\|PWD\|CREDENTIAL)[A-Z0-9_]*)\s*=\s*\S+` | 检测到 .env 赋值（KEY 名） |
| AWS 访问密钥 ID | `AKIA[0-9A-Z]{16}` | 检测到 AWS 访问密钥 ID |
| AWS secret 赋值 | `secret/access[_-]?key` + 40 字符 base64 | 检测到 AWS 风格密钥（KEY 名） |

reason 字符串**只含 KEY 名/标签**，绝不含原始密钥。

### 4.2 redactForContext(text)

防御性脱敏：把检测到的密钥替换为 `••••`，用于预览/错误片段。**不用于解锁受限附件**——受限附件一律阻断，绝不"脱敏后发送"。

### 4.3 运行时阻断（fail-closed）

- 运行时在拼上下文前对每个选中附件调 `getMetaForSend` + `getText`；`restricted` → `gateContext` 返回 `blocked` → 产出 `failed` 终端（`redactedError` 不含原始密钥），**provider 永不被调用**。
- renderer 闸 `eligibilityReason` 新增 `unavailable-attachments` reason：任何 `payloadAvailable:false` chip → Send 禁用 + Enter 失效 + 可见原因"含失效附件，请移除或重新附加后再发送"。**不静默忽略**——否则运行会带一个 vault 必拒的 id 启动并在中途失败。检查顺序在 `needs-confirmation` 之后（隐私闸优先）。

---

## 5. Artifact 只读与密钥拒绝策略

`AiArtifactRepository`（`electron/ai-platform/ai-artifact-repository.ts`）。

### 5.1 只读契约

- UI 仅暴露：`list` / `get` / `create` / `delete` / `validate-json` + preview/copy。
- **无 `ai:artifact:update` IPC**（preload/renderer 均无）。
- 仓库内部 `update()` 仅用于生成新 revision（版本历史），**不经 IPC 暴露**。
- **无 apply/writeback/execute/inject**：artifact 永不改编辑器文本、文件或会话。

### 5.2 密钥拒绝（create/update）

`assertNotRestricted(content)` 在 `create`/`update` 入口调用 `classifySensitivity(content)`：

- `restricted` → 抛 `artifact 内容含受限内容（<reason>），已拒绝`，**不写任何文件**。
- 错误信息**不含原始密钥**（只含 reason 标签）。
- `update` 被拒时原 artifact 不变（content/revisionCount/revisions 全部保持）。
- 已覆盖测试：PEM、`.env`、`.env` with `export`、AWS AKIA、AWS secret、update 拒绝且原内容不变；每条都断言"无文件落盘 + repo.list().length === 0"。

### 5.3 defense-in-depth 脱敏

- `redactSecrets(content)` 仍作为兜底：漏过 `classifySensitivity` 的残留 `sk-...` / Bearer / 长 base64 片段（例如嵌在散文里的 `sk-...`，不匹配 `^KEY=VALUE`）会被剥除后再持久化。
- **边界已钉测试**：同一个 `OPENAI_API_KEY=sk-...`，在散文里（`Here: KEY=sk-...`）被脱敏不拒绝；在行首（`KEY=sk-...`）被直接拒绝。

### 5.4 其他

- JSON artifact 在 create/update 校验合法性，非法 JSON 以安全错误拒绝。
- 单 artifact 内容上限 256 KiB，revision 历史保留最近 50 条。
- 持久化：`<userData>/ai/artifacts/<id>.json` + `index.json`，原子写（temp + rename，mode 0600）。

---

## 6. JSON 工作台集成

`src/components/tools/json-workbench/index.tsx`。

### 6.1 附加选区（Attach SELECTION）

- `attachToAi` 调 `codeRef.current?.getSelectionText()` 取**当前选区**；选区为空时回退到**全部输入**，并诚实标注（`JSON 选区` vs `JSON 全部`）。
- 经 `aiStore.ingestAttachment('json-workbench', label, text)` 进入 Context Vault（一次性 IPC，之后不回传）。

### 6.2 生成修复提案（只读）

- `generateRepairProposal` 调本地 `repairJson(input)` 生成修复结果，作为 **只读 JSON artifact** 经 `aiArtifactCreate` 存入仓库。
- **不写回编辑器**：无 apply/writeback；用户可在 Artifacts 抽屉 preview/copy。

---

## 7. 公共 IPC / preload 契约

所有 handler 经 `assertTrustedRenderer` 守卫。

### 7.1 P2 Context Vault IPC

| channel | preload | 入参 | 返回 | 行为 |
|---|---|---|---|---|
| `ai:context:ingest` | `aiContextIngest` | `{ source, title, text, storage? }` | `AiAttachmentMeta` | 原始文本一次性入主进程，返回元数据（无原文） |
| `ai:context:list` | `aiContextList` | — | `AiAttachmentMeta[]` | 合并内存（payloadAvailable:true）+ 持久化占位符（false） |
| `ai:context:delete` | `aiContextDelete` | `id` | `boolean` | 删除单附件 payload（含占位符） |
| `ai:context:clear-all` | `aiContextClearAll` | — | `boolean` | 清空全部（quit 路径） |

### 7.2 P2 Artifact IPC（只读）

| channel | preload | 入参 | 返回 | 行为 |
|---|---|---|---|---|
| `ai:artifact:list` | `aiArtifactList` | — | `AiArtifactMeta[]` | 按 updatedAt 降序 |
| `ai:artifact:get` | `aiArtifactGet` | `id` | `AiArtifactDocument \| null` | 含 content + revisions |
| `ai:artifact:create` | `aiArtifactCreate` | `{ kind, title, content, language?, conversationId?, runId? }` | `AiArtifactDocument` | 受限内容拒绝（不写盘）；JSON 校验；redactSecrets 兜底 |
| `ai:artifact:delete` | `aiArtifactDelete` | `id` | `boolean` | — |
| `ai:artifact:validate-json` | `aiArtifactValidateJson` | `content` | `{ valid, error? }` | 不创建 artifact |

**明确不存在**：`ai:artifact:update`（preload/IPC/renderer 均无；仓库内部 `update` 仅用于 revision，不暴露）。

### 7.3 ai:run:start 附件校验

- `attachmentIds`（显式，可选）。超 `AI_CONTEXT_MAX_ATTACHMENTS_PER_RUN` → 同步抛错。
- `contextVault.validateIds(attachmentIds)` 拒绝未知/非法/占位符 id → 同步抛错，不分配 runId。
- 仅显式列出的 id 进入运行；无隐式组件上下文。

---

## 8. 测试命令

```bash
# 完整 AI 套件（含 build:electron → 10 个测试文件）
npm run test:ai

# 单文件
node --test tests/ai-context-vault-artifacts.test.mjs
node --test tests/ai-context-runtime-ipc.test.mjs
node --test tests/ai-eligibility.test.mjs
node --test tests/ai-sensitivity-budget.test.mjs

# 其他验证（P2 未触碰，须保持全绿）
npm run test:diagrams
npm run verify:mcp
```

### 8.1 测试隔离（IPC）

`tests/fixtures/electron-stub.mjs` 提供 `createIpcScope()`：每个 `makeIpcFixture` 获得独立 handler map，`registerAiIpc` 写入当前激活 scope，`invokeHandlerFor(scope, ...)` 只命中该 scope。node:test 并发运行多个 suite 时（`ai-context-runtime-ipc` 与 `ai-capability-enforcement` 都调 `registerAiIpc`），不再共享全局 handler map 竞态。`test:ai` 连跑两次稳定 184/184。

### 8.2 测试覆盖要点

- Vault：ingest 元数据无原文、原文永不落盘、TTL 过期、delete/clearAll/clearForRun、validateIds、metadata-only 重启占位符、ephemeral 不存活、`payloadAvailable` 字段契约。
- Artifact：create/get/list/delete、revision 历史、JSON 校验、**受限内容拒绝（PEM/.env/export/AWS AKIA/AWS secret/update 拒绝且原内容不变）+ 无文件落盘**、defense-in-depth 脱敏边界、reject-vs-redact 边界、无 apply/writeback 方法、超限拒绝。
- 运行时/IPC：仅显式附件进上下文、受限 fail-closed（provider 不调用）、terminal 清理 payload、`ai:run:start` 校验（未知/非法/超上限）、无 `ai:artifact:update` handler、所有 handler 经 trust 守卫。
- 资格闸：`unavailable-attachments` fail-closed（含"不静默忽略"断言、检查顺序在 `needs-confirmation` 之后、`canStartRun` 镜像）。

---

## 9. 移交 P3 的已知约束

P2 已完成且**未开始 P3**。移交 P3 时须遵守：

1. **无工具调用**：P2 无 Tool Registry、无 ToolCallCard、无 ApprovalCard、无 Audit Log。P3 引入时须确保工具无法绕过审批，模型输出不得当作命令执行，所有 write 有可见影响范围。
2. **无 MCP**：P2 无 MCP client/server。P4 引入时须做 stdio command 风险提示、断开/重连、MCP instructions 无法提权。
3. **无 Agent loop / 无子 agent**：P2 仅 `chat` 模式。P5 开放 Agent 时须带 8 步预算、审批暂停/恢复、工具 trace；`push` 不注册给 Agent。
4. **无 Git 写回**：P2 无 Git 工作台接入。P5 接入时为 staged-only context + commit proposal + 受确认 stage/commit。
5. **Artifact 不得引入 apply/writeback**：P3+ 若要让 artifact 写回组件，须新增显式 `write` 风险动作并经审批（plan §5.3），不得在 P2 只读仓库上加隐式写回。
6. **Context Vault 原文边界不可破**：P3+ 任何工具结果若需进入上下文，须经同样的 ingest 一次性路径 + 敏感扫描 + 预算闸，不得绕过 vault 直接拼 prompt。
7. **测试隔离模式须延续**：新增 IPC suite 须用 `createIpcScope()`，不得回退到全局 handler map。
8. **无 commit/push**：本阶段不执行 `git commit` / `git push`。

---

## 10. 文件清单

**新增**（P2）：

- `electron/ai-platform/ai-context-types.ts` — P2 类型 + 预算常量
- `electron/ai-platform/ai-sensitivity-scanner.ts` — 纯敏感扫描
- `electron/ai-platform/ai-context-budget.ts` — 纯预算闸
- `electron/ai-platform/ai-context-vault.ts` — 主进程附件金库
- `electron/ai-platform/ai-artifact-repository.ts` — 只读 artifact 仓库
- `tests/ai-sensitivity-budget.test.mjs`
- `tests/ai-context-vault-artifacts.test.mjs`
- `tests/ai-context-runtime-ipc.test.mjs`

**修改**（P2）：

- `electron/ai-platform/ai-runtime.ts` — contextVault 依赖 + 预算闸 + 受限 fail-closed + clearForRun
- `electron/ai-platform/ai-ipc.ts` — P2 IPC handler + `ai:run:start` 附件校验 + 注释订正
- `electron/ai-platform/ai-eligibility.ts` — `attachments` + `unavailable-attachments` 闸
- `electron/ai-platform/index.ts` — 装配 vault + artifact repo
- `electron/main.ts` — `before-quit` 清 vault
- `electron/preload.ts` — P2 API 暴露（无 `aiArtifactUpdate`）
- `src/types/raintool.d.ts` — P2 API 类型
- `src/store/ai.ts` — attachments/artifacts 状态 + clearAttachments + startRun catch + 闸
- `src/components/tools/ai-assistant.tsx` — AttachmentChips（失效标注）+ ArtifactsDrawer + 闸
- `src/components/tools/CodeArea.tsx` — `getSelectionText()`
- `src/components/tools/json-workbench/index.tsx` — 附加选区 + 只读修复提案
- `tests/ai-eligibility.test.mjs` — 7 条 `unavailable-attachments` 闸测试
- `tests/ai-capability-enforcement.test.mjs` — 改用 `createIpcScope()` 隔离
- `tests/fixtures/electron-stub.mjs` — `createIpcScope()` 隔离注册
- `docs/ai-platform-plan.md` — P2 状态 + §5.2/§5.3 实现补充
- `docs/ai-platform-p0-spike.md` — §8.4 实现补充
