# RainTool 通用 AI 平台实施方案

## 1. 产品定位

RainTool 的 AI 不是一个孤立的聊天页面，也不是让每个工具各自接一个模型 API；它是应用级平台，为所有工具提供统一的：

```text
多模型与凭据 → 对话与会话 → 上下文与附件 → 工具/MCP → Agent 编排 → 审批与审计
```

用户在任何工具中都能发起同一个助手，并**显式选择**是否把当前工具的内容加入会话；Agent 可以调用该工具注册的能力，但只能在权限策略允许的范围内运行。

### 1.1 目标

1. 支持云端与本地模型、多个模型配置和按会话切换。
2. 提供通用对话、流式输出、会话历史、附件、Markdown/代码/图表产物。
3. 支持组件贡献上下文与受控工具，不改变通用 tabs 结构。
4. 同时支持内建工具和外部 MCP Server，使用同一套工具卡片、审批、日志和错误处理。
5. 让 Agent 可规划、调用工具和展示过程，但对写入及危险行为维持用户确认。
6. 让 Git 工作台、JSON 工作台、图纸管理、AI Draw.io 逐步接入，而不是重写它们。

### 1.2 非目标

- 不做一个可任意执行 shell 的通用 Agent。
- 不自动读取全部标签、磁盘文件、剪贴板、Git Diff 或历史会话。
- 不自动提交、推送、删除数据或改写图纸。
- 不在第一版做多人协作、云同步、账号体系、团队知识库或支付。
- 不把 Cherry Studio、LibreChat、DeepChat、LobeHub 等完整项目嵌入 RainTool。

## 2. 用户体验

### 2.1 一个助手，三种会话模式

| 模式 | 默认能力 | 适用场景 |
|---|---|---|
| 对话 | 模型 + 用户明确附加的内容；没有工具调用 | 解释 JSON、讨论设计、总结图纸 |
| 助手 | 对话 + 用户启用的只读工具 | 查询 Git 状态、读取图纸、检查 JSON |
| Agent | 助手能力 + 提议/写入工具；按审批策略暂停 | 生成图纸草稿、暂存文件、创建提交说明 |

每个会话在顶部显示模型、模式、启用工具数和上下文预算。切换为 Agent 不会自动授予更多能力，仍需用户选择工具并遵守每次调用的风险级别。

### 2.2 通用 AI 工作区

新增 `AI 助手` 工具标签。它是主聊天入口，并允许各组件通过“在 AI 中继续”将当前上下文带入新会话或现有会话。

```text
┌ 会话列表 ─ 新对话 ─ 搜索 ┬ 模型 / 对话·助手·Agent / 上下文 / 工具 ┐
│                           │ 消息流：文本、代码、图表、工具调用、审批卡片 │
│                           │                                                │
│                           │ [附件与上下文 chips]                           │
│                           │ 输入框 ─ 停止 ─ 发送                           │
└───────────────────────────┴────────────────────────────────────────────────┘
```

### 2.3 组件接入体验

每个组件至多增加两个低干扰入口：

- **询问 AI**：打开/聚焦通用会话，并附上由用户确认的当前上下文。
- **交给 Agent**：仅当该组件具备可执行 Action 时显示；先打开任务预览，不能直接修改数据。

上下文由 chip 明确列出，例如：

```text
附加到本次提问
[当前 JSON 选区：1.8 KB] [Git 已暂存 Diff：已过滤 3 个敏感文件] [图纸：支付流程图]
```

用户可逐项删除；每项显示来源、大小、脱敏状态和是否会随会话保存。

### 2.4 工具调用与审批卡

消息流中每个工具调用都是可展开的事件卡：工具名称、输入摘要、影响范围、开始/结束时间、结果摘要、完整日志（脱敏后）。

| 风险等级 | 默认策略 | 示例 |
|---|---|---|
| `read` | 本会话首次启用时确认一次，之后可自动运行 | 获取 Git status、读取当前图纸 |
| `propose` | 可自动运行，只产生预览，不写入 | 生成 commit message、生成图纸 XML 草稿 |
| `write` | 每次显示预览和确认按钮 | 暂存指定文件、保存图纸新版本 |
| `dangerous` | 第一版不向模型开放；后续始终逐次确认 | push、删除、覆盖工作区文件 |

审批卡必须包含“执行什么、影响什么、为什么需要、可否撤销”。拒绝时，系统把明确的拒绝原因回传给模型，例如：`用户拒绝执行 git stage：请继续提供只读分析或提出更小的可确认操作。`

## 3. 平台架构

### 3.1 分层

```text
React UI
  AI 工作区 / 对话 / 上下文选择 / 工具结果 / 审批卡
        │ 受类型约束的 IPC，按 runId 流式事件
Electron 主进程：AI Platform Runtime
  会话仓库 · Provider Router · Context Vault · Tool Registry
  Agent Loop · Approval Manager · MCP Client Manager · Audit Log
        │
模型提供商 / 内建 RainTool 工具 / 外部 MCP Server
```

模型请求、MCP 进程、凭据、工具执行、文件访问必须在主进程；渲染层只消费事件和提交已验证的用户意图。

### 3.2 推荐目录

```text
electron/ai-platform/
  ai-types.ts                 # DTO、事件、模型和权限枚举
  ai-runtime.ts               # run 生命周期、取消、并发与总超时
  ai-conversation-repository.ts # 会话索引、消息与附件元数据迁移
  ai-credential-vault.ts      # Electron safeStorage；仅主进程可读
  ai-provider-registry.ts     # Provider/ModelProfile 注册与能力发现
  ai-provider-openai.ts       # OpenAI-compatible adapter
  ai-provider-anthropic.ts    # Anthropic adapter
  ai-provider-google.ts       # Gemini adapter
  ai-context-vault.ts         # 附件限额、脱敏、短期内容缓存
  ai-tool-registry.ts         # 内建工具 schema、风险和 executor
  ai-approval-manager.ts      # 单次审批、拒绝理由与过期处理
  ai-agent-runner.ts          # 工具循环、步数/成本/时间限制
  ai-mcp-manager.ts           # MCP 配置、连接、工具发现与断开
  ai-audit-log.ts             # 脱敏后的 run/tool/approval 事件

src/components/tools/ai-assistant/
  index.tsx
  ConversationSidebar.tsx
  ConversationView.tsx
  Composer.tsx
  ContextTray.tsx
  ToolCallCard.tsx
  ApprovalCard.tsx
  ArtifactPanel.tsx
  AiSettings.tsx

src/ai/
  component-contract.ts        # 组件声明 Context / Tool 的共享类型
  integrations/
    git.ts
    diagrams.ts
    json.ts
src/store/ai.ts                # UI 会话、当前 run、草稿；没有 API Key
tests/ai-platform/*.test.mjs
docs/ai-platform.md            # 用户隐私、MCP 安全、升级说明
```

### 3.3 核心类型

```ts
type AiToolRisk = 'read' | 'propose' | 'write' | 'dangerous'
type AiRunMode = 'chat' | 'assistant' | 'agent'

interface AiModelProfile {
  id: string
  providerId: string
  displayName: string
  model: string
  capabilities: {
    vision: boolean
    toolCalling: boolean
    jsonSchema: boolean
    reasoning: boolean
  }
  maxInputTokens?: number
}

interface AiContextAttachment {
  id: string
  source: string                 // git-workbench / diagram-manager / json-workbench
  title: string
  mimeType: string
  contentRef: string             // 指向主进程 Context Vault，不把大内容塞进 IPC 历史
  byteSize: number
  sensitivity: 'normal' | 'redacted' | 'restricted'
  persistMode: 'metadata-only' | 'encrypted-content' | 'ephemeral'
}

interface AiToolDefinition<Input, Output> {
  id: string
  title: string
  description: string
  inputSchema: unknown           // Zod schema 转 JSON Schema
  risk: AiToolRisk
  componentId: string
  execute: (input: Input, context: AiToolExecutionContext) => Promise<Output>
  preview?: (input: Input, context: AiToolExecutionContext) => Promise<AiPreview>
}

interface AiRunEvent {
  runId: string
  sequence: number
  type: 'started' | 'text-delta' | 'tool-requested' | 'approval-required'
    | 'tool-finished' | 'completed' | 'failed' | 'cancelled'
  payload: unknown
}
```

组件只可声明自己拥有的数据源和窄工具，禁止把任意 `execute(command)`、文件系统根目录或完整渲染状态注册为工具。

## 4. Provider、凭据与模型策略

### 4.1 Provider 插件化，而非供应商堆砌

第一批内建 Provider：

1. **OpenAI-compatible**：覆盖 OpenAI-compatible API、OpenRouter、DeepSeek、部分企业网关与本地兼容端点。
2. **Anthropic**：独立适配，支持其工具调用与图像输入能力。
3. **Google Gemini**：独立适配，支持 Gemini 的多模态能力。
4. **Ollama**：本地模型，默认本机地址但仍需用户确认端点。

Provider Registry 只暴露统一 `streamText / generateObject / toolLoop` 能力；模型是否支持视觉、结构化输出、工具调用由 `AiModelProfile` 声明，不能靠模型名字符串猜测。

### 4.2 运行时选择

- 每个会话固定一个 Model Profile；重新生成可临时切换，历史中记录实际模型。
- 工具调用需要模型标记为 `toolCalling`，否则 UI 自动降级为对话模式。
- JSON 结构化输出优先使用 provider 的 JSON Schema / structured output；不支持时采用严格 JSON prompt + Zod 校验 + 一次修复重试。
- 设每会话总输入、单次输出、工具轮次、总时长预算；默认 Agent 最多 8 个工具步骤、10 分钟，随时可停止。

### 4.3 密钥与隐私

- API Key/Token 通过 `safeStorage` 加密后保存，主进程是唯一读者；`safeStorage` 不可用时禁用保存，不得明文回退。
- 设置页只能显示掩码值和“已配置”；IPC、日志、崩溃报告、导出包和聊天消息都不得携带密钥。
- 会话默认只持久化消息文本和附件元数据；Git Diff、选中 JSON、图纸 XML 等原始附件默认 `ephemeral`，重新打开会话须用户再次附加。
- 每个会话提供“删除会话与本地附件”“仅本次会话不保存”“导出脱敏副本”。
- 出网提示应列出 provider、模型、附件数及脱敏文件数；用户可在设置中按 Provider 禁用网络。

### 4.4 依赖选择与兼容性 Gate

优先借鉴 Vercel AI SDK 的 Provider/stream/tool-loop 抽象，但**不能在未验证前直接引入最新版**：其当前 README 要求 Node.js 22+，而 RainTool 当前 Electron 33 的内嵌 Node 版本必须先由 ZCode 实测确认。

Gate P0 要求：

1. 运行打包 Electron，记录 `process.versions.node`。
2. 选择仍支持该 Node 版本且有安全维护的 AI SDK 版本，或以标准 `fetch` 适配器实现相同的内部接口。
3. 不为了引入 AI SDK 顺手升级 Electron；Electron 升级必须是单独变更、单独回归。

## 5. 对话、上下文与产物

### 5.1 会话模型

```text
Conversation
  ├─ metadata（标题、模型、模式、创建/更新时间）
  ├─ messages（用户/助手/系统/工具/审批）
  ├─ attachment metadata（不默认存原文）
  ├─ enabled tools snapshot
  └─ run audit references
```

新消息可来自用户输入、组件快捷入口或 Agent 的工具结果。会话标题由首条用户消息本地截取或模型建议生成，但模型建议不得覆盖用户手改标题。

### 5.2 上下文预算与压缩

上下文选择器在发送前计算附件大小和估算 token；超过模型预算时按用户可见规则处理：

1. 优先保留用户刚选的内容和系统安全说明。
2. 对旧消息生成本地/模型摘要，保留可追溯 message ID。
3. 对大附件截断为文件摘要 + 用户选择的片段，而不是静默丢弃。
4. 最终 UI 明确显示"已截断/已摘要"的条目。

**P2 实现补充（已落地）**：

- 附件以显式选择为准——只有用户在 chip 里选中的 `attachmentIds` 才会进入运行上下文，组件不得偷偷附加。IPC 边界在 `ai:run:start` 校验 id（未知/非法/超上限一律同步拒绝）。
- 敏感内容（`.env` 赋值、PEM 私钥、AWS AKIA/secret）由 `classifySensitivity` 判为 `restricted`，运行时 **fail-closed**：受限附件直接产出 `failed` 终端事件，绝不调用 provider。
- 附件原始文本仅经 `ai:context:ingest` IPC **一次性**送入主进程 Context Vault，之后永不回传 renderer、永不记日志、永不落盘（ephemeral 默认；metadata-only 仅存不含原文的元数据）。
- 重启后 metadata-only 占位符以 `payloadAvailable:false` 出现在列表里，但其 payload 已丢失。`AttachmentChips` 显式标注"已失效"，且 `eligibilityReason` 的 `unavailable-attachments` 闸 **fail-closed 阻断发送**（Send 禁用 + Enter 失效 + 可见原因"含失效附件，请移除或重新附加后再发送"），绝不静默忽略——否则运行会带着一个 vault 必拒的 id 启动并在中途失败。

### 5.3 Artifact

模型产生的可继续使用内容保存为 artifact：Markdown、代码、JSON、Mermaid、图纸草稿、commit proposal。Artifact 是"建议或预览"，不是直接写回组件；组件自己提供 `applyArtifact` Action，且该 Action 为 `write` 风险。

**P2 实现补充（已落地）**：

- P2 artifact 仓库为**只读建议**：UI 仅暴露 list/get/create/delete/validate-json 与 preview/copy，**没有 `ai:artifact:update` IPC**，**没有 apply/writeback/execute/inject**。仓库内部 `update` 仅用于生成新 revision（版本历史），不经 IPC 暴露给 renderer。
- 持久化前 `classifySensitivity(content)` 对 PEM/`.env`/AWS secret **直接拒绝**（create/update 均校验），安全错误信息不含原始密钥，且**不写任何文件**。`redactSecrets` 作为 defense-in-depth 仍会剥除漏过分类的残留 `sk-...` 等片段。
- JSON artifact 在 create/update 时校验合法性，非法 JSON 以安全错误拒绝。

## 6. 工具与组件接入协议

### 6.1 内建工具

内建工具在主进程注册并经过 schema 校验。每个工具必须具备单一用途、有限输入、明确风险与结构化结果。

| 组件 | 只读工具 | propose 工具 | write 工具 |
|---|---|---|---|
| Git 工作台 | 状态、分支、选中文件 Diff、staged 摘要 | commit message、变更风险说明 | stage 已选文件、创建 commit（每次确认） |
| 图纸管理 | 图纸列表、读取当前图纸、检查结果 | 生成/修订 XML 草稿 | 创建图纸、保存新的 revision（确认） |
| JSON 工作台 | 读取用户选区、校验错误 | JSON 修复方案、类型定义草稿 | 将修复写入编辑器（确认） |
| 通用 | 当前时间、应用版本 | — | — |

Git `push`、丢弃工作区改动、删除图纸等暂不注册给 Agent；即便未来开放也始终为 `dangerous`。

### 6.2 组件声明约定

每个工具在 `src/ai/integrations/<tool>.ts` 维护自己可附加的上下文描述，且在对应 Electron 服务中注册实际 executor。React 组件只能请求“附加当前图纸”“附加 JSON 选区”等明确动作，不能自行拼接系统 prompt 或将内容偷偷发送到模型。

```ts
interface AiComponentContribution {
  componentId: string
  contextOptions: Array<{
    id: string
    title: string
    createAttachment: () => Promise<AiContextAttachment>
  }>
  toolIds: string[]
  artifactTypes: string[]
}
```

### 6.3 内建工具与 MCP 的统一

MCP 工具经 `ai-mcp-manager` 发现后，转换为 `AiToolDefinition` 的受限适配器。其工具说明、schema、server instructions 都视为不可信外部输入，不能覆盖 RainTool 的系统安全策略或审批规则。

- Phase 1 支持可信、用户手工配置的 `stdio` 和本机 `127.0.0.1` MCP。
- 添加 `stdio` Server 前必须展示实际 command、args、来源和“它会在本机执行进程”的高风险提示；不支持从聊天内容一键安装 Server。
- 外网 Streamable HTTP、OAuth、MCP sampling/elicitation 放到后续阶段；采样和表单请求必须转为 RainTool 审批 UI，不能静默代答。
- 当前 RainTool 图纸 MCP Bridge 保持独立运行；AI Platform 可在后续用它作为一个已知本机 MCP client，不重写现有协议。

## 7. Agent Runtime

### 7.1 状态机

```text
idle → preparing-context → streaming-model
     → tool-requested → [approval-required → approved/rejected]
     → executing-tool → streaming-model
     → completed | failed | cancelled | budget-exhausted
```

所有状态转换产生带递增 sequence 的 `AiRunEvent`，渲染层可断线恢复；Agent 停止时会取消正在等待的模型流或工具，并把最后可用结果保留为草稿。

### 7.2 Agent Loop 约束

- 每轮模型只能调用本会话已启用且模型有权限知道的工具。
- 工具输入先 Zod/JSON Schema 验证，再做业务级验证；任何额外字段、未知 repo ID、未知 diagram ID 都拒绝。
- read/propose 可继续；write 遇到审批会暂停，不占用模型连接，批准后再执行并将结果作为新工具消息继续。
- 拒绝、失败、超时、预算耗尽都产生明确事件，模型收到简短事实说明，不收到原始敏感错误。
- 不启用多 Agent 自我委派；复杂任务先由一个 Agent 以可见计划和工具步骤完成。多 Agent 只有在稳定的事件、成本和权限模型建立后再评估。

### 7.3 审计与可观测性

每次 run 记录模型、耗时、token（若 provider 提供）、工具、审批决定和脱敏错误。日志按会话可查看、可删除；不记录 API Key、完整敏感附件或未脱敏 MCP stderr。

## 8. 实施阶段与审核门

### P0：架构 Spike 与兼容性（先做）

1. 阅读本方案和现有 Electron 安全边界 `assertTrustedRenderer`、preload、图纸 MCP。
2. 验证 Electron 内嵌 Node 与候选依赖兼容性；决定 AI SDK 版本或内部 fetch adapter。
3. 写出最小 provider mock、stream event contract 和会话 migration 格式，不接真实密钥、MCP 或 Agent。
4. 新增依赖许可证清单，确保不引入 AGPL/Fair Source 代码。

**Gate P0 审核**：依赖/许可决定、运行时版本、事件合约和目录结构。不得改动 AI Draw.io、MCP bridge、通用 tabs。

### P1：Provider、设置与会话

1. 实现 Credential Vault、Model Profiles、OpenAI-compatible Provider、Ollama Provider。
2. 实现会话仓库、流式 IPC、取消、错误事件、AI 助手基础 UI。
3. 完成隐私提示、会话删除、key 不可回传测试。

**Gate P1 审核**：主进程密钥边界、断流/取消、数据迁移、可打包性。此阶段没有工具调用。

### P2：上下文和 Artifact

1. 实现 Context Vault、预算、附件 chip、metadata-only/ephemeral 策略。
2. 实现 Markdown/JSON/代码 artifact 与预览，不写回任何组件。
3. 首先接 JSON 工作台的"附加选区"和"生成修复方案"。

**Gate P2 审核**：上下文显式选择、大小限制、敏感内容处理、附件不被意外持久化。

**状态（已落地）**：Context Vault（ephemeral 默认 + metadata-only 占位符 + `payloadAvailable` 区分可发送/占位）、预算闸（每附件 + 总额，受限 fail-closed）、敏感扫描（`.env`/PEM/AWS，受限阻断）、只读 Artifact 仓库（受限内容 create/update 直接拒绝、不写盘、`redactSecrets` 兜底、无 `ai:artifact:update` IPC、无 apply/writeback）、JSON 工作台"附加选区"+ 只读修复方案、附件 chip 失效 fail-closed UX（Send 禁用 + 可见原因，不静默忽略）。详见 `docs/ai-platform-p2.md`。**P3 未开始**：无 Tool Registry、无审批、无 MCP、无 Agent、无 Git 写回、无 commit/push。

### P3：内建工具与审批

1. Tool Registry、schema 校验、ToolCallCard、ApprovalCard、Audit Log。
2. 接入 JSON 的只读/propose 工具；实现一个受确认的写入 demo。
3. 实现拒绝原因回传和 run 状态机恢复。

**Gate P3 审核**：工具无法绕过审批；模型输出不能当作命令执行；所有 write 都有可见影响范围。

**状态（已落地）**：Tool Registry（allowlist + Zod strict + directInvocationAllowed 在 chat 模式可达）、Approval Manager（单次 TTL、7 字段绑定、default-deny consume、reject 必须非空原因、受限原因拒绝、`inspect()` 类型化读取）、Audit Log（append-only、无 renderer clear、固定元数据不含原始输入、5000 条 FIFO 轮转无重复、secret 清洗）、3 个 JSON 工具（inspect read / propose propose / apply write）、跨进程 apply 协调（main 拥有 token+hash+revision、renderer 仅 ack、mismatch 返回 IPC 拒绝并解析 tool 失败、cancel 即时终止）、direct-tool 运行无需 profile/credential、ToolCallCard + ApprovalCard（拒绝需可见非空原因、无键盘/隐藏批准）、JSON Workbench inspect/propose/apply 按钮 + apply-request 修订检查、propose→只读 artifact（`kind=json`，`artifactRef` 经 tool-completed 上行，repository 拒绝时映射为 tool-failed 而非静默丢弃）。`tests/ai-tools-approval.test.mjs` 55 项 + `tests/ai-p3-tools-approval.test.mjs` 46 项全绿。详见 `docs/ai-platform-p3.md`。

### P4：MCP Client 与图纸接入

1. 基于 MCP TypeScript SDK 的稳定 v1.x 接入已知本机 `stdio`/loopback Server。
2. 实现 MCP Server 配置、安全确认、工具发现、错误状态、进程生命周期。
3. 将现有 RainTool 图纸 MCP 以只读/受确认 write 的方式接入；不破坏 ZCode/Codex 已使用的服务端。

**Gate P4 审核**：stdio command 风险提示、断开/重连、MCP instructions 无法提升权限、现有图纸测试全绿。

**状态（已落地）**：MCP Client Manager（main 进程独占，renderer 永不 spawn/connect）、配置仓库（`userData/ai/mcp-servers.json`，仅元数据，原子写 0600，读取时逐项 `validateServerEntry` 校验）、三种受信来源（`trusted-built-in` 内置 RainTool MCP / `user-stdio` / `user-loopback`）、主进程单次 TTL 确认（nonce + `commandFingerprint` 绑定，配置变更即失效，renderer 无法伪造激活）、spawn-without-shell + 最小化 env + 边界长度/超时、SDK v1 connect + listTools、untrusted-data 处理（instructions 丢弃、工具元数据脱敏截断、generic 工具 inventory-only/not-executable）、lifecycle（disconnect/quit 关闭、failed-connect 清理、idempotent reconnect、in-flight 去重、`disconnectAll` 在 `before-quit` await）、RainTool 图纸适配器（read 直接执行 / write 经 P3 审批门、排除 delete/export/path、无任意 MCP call IPC、无 artifact apply 捷径、`onChanged` 镜像 diagram-bridge）、`AiMcpConfirmationRequest` 源-gated（stdio 暴露 command+args / loopback 暴露 url）、`BoundedStderrSink`（字节封顶、UTF-8 边界、main 内部诊断，外向 `reason = sanitizeError(error)` only，绝不回显 stderr）、共享 helpers（`sha256Hex`/`fingerprintStdio`/`fingerprintLoopback`/`FINGERPRINT_BUILT_IN`/`isLoopbackUrl` raw-URL 遍历加固、`BoundedStderrSink`）、preload + raintool.d.ts 窄 API、`McpServersDrawer` UI（状态/工具清单、添加内置/stdio/loopback、激活确认、断开/重连，无 raw stderr/instructions）。MCP SDK `@modelcontextprotocol/sdk@1.29.0`（MIT，v1，Node 20 兼容）作为根依赖固定，license 记录于 `THIRD_PARTY_NOTICES.md` + `LICENSES/modelcontextprotocol-sdk-MIT.txt`。**P4 未实现**：模型 tool-calling、Agent loop、可执行 generic MCP 工具、remote/OAuth/sampling/elicitation 传输、artifact apply/writeback。详见 `docs/ai-platform-p4.md`。

### P5：Agent 与 Git 工作台接入

1. 开放 Agent mode、8 步预算、审批暂停/恢复、工具 trace。
2. 按 `docs/git-workbench-plan.md` 先完成 Git 的非 AI 基础能力。
3. Git 再接入为 staged-only context、commit proposal 和受确认的 stage/commit；push 不注册给 Agent。

**Gate P5 审核**：Git Diff 不泄露到未经选择的会话；审批、拒绝、失败和重复执行均可预测。

### P6：文档、升级与回归

1. `docs/ai-platform.md`：Provider 配置、隐私、MCP 风险、会话删除、故障排查、升级策略。
2. 更新 README、`THIRD_PARTY_NOTICES.md`、打包许可证目录。
3. 新增单元/集成测试并运行既有 `npm run verify:mcp`、`npm run test:diagrams`、build/package 验证。

## 9. 测试矩阵

| 场景 | 必须结果 |
|---|---|
| 无模型 / API Key 无效 | UI 可恢复；不泄露 key；普通工具仍可使用 |
| 流式响应取消 | 主进程终止请求；消息保留为已中断草稿 |
| 模型不支持 tool calling | 自动降级为对话，不伪造工具能力 |
| 超大 JSON/Diff/图纸附件 | 明示截断或摘要；不阻塞 UI、不静默外发 |
| `.env`、私钥、token | 默认拒绝/脱敏；审计日志没有原文 |
| write 工具被拒绝 | 不执行、模型收到明确拒绝原因、可继续对话 |
| Agent 超过步骤/时间预算 | 停止并保留 trace，不循环调用 |
| MCP stdio server 崩溃 | 连接状态为错误，可重连，应用不退出 |
| 旧 RainTool 图纸功能 | 既有 MCP、图纸管理、AI Draw.io 全部回归通过 |
| 应用重启 | 密钥仍不可读；会话索引可恢复；ephemeral 附件不被重放 |

## 10. 开源参考与许可证策略

| 项目 | 借鉴内容 | 许可与使用决定 |
|---|---|---|
| [DeepChat](https://github.com/thinkinaixyz/deepchat) | Electron 桌面端的多模型、MCP、Skills、ACP 与会话工作区产品结构 | Apache-2.0；可研究架构，逐文件核对后才可复用 |
| [LibreChat](https://github.com/danny-avila/LibreChat) / [agents](https://github.com/danny-avila/agents) | Agent 图编排、流式事件、工具执行、Provider adapter 的拆分 | 主项目/agents 为 MIT；优先参考其事件与权限分层，不整体嵌入 web 服务 |
| [NextChat](https://github.com/ChatGPTNextWeb/NextChat) | 轻量会话、多 Provider、MCP 设置的 UX | MIT；借鉴体验与配置模型 |
| [LobeHub](https://github.com/lobehub/lobehub) | Agent 为工作单位、工具/插件生态和 artifact 呈现 | 仅参考产品设计；确认具体包许可证后再考虑代码 |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | 桌面端多模型、Agent、MCP 与助手市场的完整产品形态 | AGPL-3.0；**不得复制或链接进 RainTool** |
| [Vercel AI SDK](https://github.com/vercel/ai) | Provider 统一接口、流式输出、tool loop | 先通过 P0 的 Node 兼容 Gate；不能假定最新版可运行 |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | 标准 MCP Client、stdio/HTTP transport、授权流程 | 使用生产稳定的 v1.x；当前 main/v2 为预发布，不跟随 main |
| [OpenCode](https://github.com/anomalyco/opencode) | TypeScript 的 provider 无关 Agent、plan/build 模式、工具许可、client/server 分离和 MCP 生命周期 | MIT；可逐文件研究或复用与 Electron 兼容的纯 TypeScript 模块，但不嵌入其 TUI/Bun runtime，也不照搬通用 Bash 权限模型 |
| 本地 [RainCode](/Users/xiayu/IdeaProjects/temu/work/raincode) | 已落地的持久会话、流式 model run、工具循环、计划/Diff 审批、项目边界、Skills/Plugins、受控命令与 Git 提交 | 同一维护方的内部代码；作为第一优先级的业务与安全蓝图，按 Electron/TypeScript 重新实现，不把 Java Spring Boot/Tauri backend 打进 RainTool |

复制任何第三方源代码前，必须检查该文件及其依赖的 license、保留版权、更新 `THIRD_PARTY_NOTICES.md`；产品行为借鉴不等于代码复用。

### 10.1 RainCode 与 OpenCode 的复用决定

#### 优先移植 RainCode 的设计与测试语义

RainCode 已有最贴近本项目目标的代码和验证边界，ZCode 在 P0 必须阅读以下内容，并将其职责映射到本方案的 TypeScript 模块：

| RainCode 来源 | 要移植的职责 | RainTool 目标 |
|---|---|---|
| [ModelToolLoopService.java](/Users/xiayu/IdeaProjects/temu/work/raincode/raincode-core/src/main/java/com/raincode/agent/model/ModelToolLoopService.java) | 模型工具循环、checkpoint、工具参数修复、步骤/并发预算 | `ai-agent-runner.ts`，但第一版关闭 subagent 自我委派 |
| [AgentToolRegistry.java](/Users/xiayu/IdeaProjects/temu/work/raincode/raincode-core/src/main/java/com/raincode/agent/model/AgentToolRegistry.java) | 按模式/权限筛选 Tool schema | `ai-tool-registry.ts`，仅注册 RainTool 组件的窄能力 |
| [ToolExecutionPolicy.java](/Users/xiayu/IdeaProjects/temu/work/raincode/raincode-core/src/main/java/com/raincode/agent/model/ToolExecutionPolicy.java) | 幂等性、副作用、重试、恢复、超时 | `AiToolRisk` 外加 retry/replay/timeout policy |
| [security-model.md](/Users/xiayu/IdeaProjects/temu/work/raincode/docs/security-model.md) | 项目边界、敏感文件、计划与 Diff 双审批 | Context Vault、Tool Registry、Approval Manager 的验收用例 |
| [architecture.md](/Users/xiayu/IdeaProjects/temu/work/raincode/docs/architecture.md) | Runtime / Tool / Permission / Event Store 分层 | 保持同样的职责边界，通讯改为 Electron IPC stream |

不要直接带入 RainCode 的以下实现：

- Java/Spring Boot Controller、HTTP/SSE、jlink 打包和 Tauri 壳；它们会给 Electron 版引入第二套运行时、端口和升级链。
- 通用 `run_command`、任意本地文件读写、子 Agent 并发执行；RainTool 初期只开放组件专用工具。
- RainCode 当前 README 所述的 plaintext `~/.raincode/config.json` API Key 存储；RainTool 必须使用 `safeStorage`，不能倒退。

#### 有选择地借鉴 OpenCode

OpenCode 的 `plan`（只读）与 `build`（全能力）Agent 分工、权限配置、工具调用事件和 MCP 断开清理值得借鉴。OpenCode 采用 MIT 许可，可以在核对具体文件依赖后复用兼容的 TypeScript 实现。

但 OpenCode 的安全文档明确其 permission 是用户体验提示而不是安全沙箱，且外部 MCP Server 不在其信任边界内。因此 RainTool 不得将“确认过一次 Bash”视为安全隔离；必须保持本方案的主进程工具白名单、组件根边界、每次 write 审批和 MCP command 安装确认。

## 11. 给 ZCode 的启动指令

```text
阅读 docs/ai-platform-plan.md，只执行 P0（架构 Spike 与兼容性）。
同时阅读本地 RainCode 的 `docs/architecture.md`、`docs/security-model.md`、`ModelToolLoopService.java`、`AgentToolRegistry.java` 与 `ToolExecutionPolicy.java`；仅产出 TypeScript 映射和测试计划，不复制 Java/Tauri 运行时。
研究 OpenCode 时仅引用 MIT 许可的兼容代码或设计，记录具体文件与 license；不得引入通用 Bash 或将 permission 当成 sandbox。
不要实现聊天 UI、MCP、Agent、Git 功能，也不要修改 AI Draw.io、现有图纸 MCP 或通用 tabs。
完成后停止，报告：Electron 内嵌 Node 版本、候选依赖和许可证、推荐 runtime 方案、事件契约草案、变更文件、测试结果与风险；等待审核后再进行 P1。
```

后续严格按 P0 → P6 的 Gate 审核。每个阶段单独提交，未经审核不得提前实现下一阶段。
