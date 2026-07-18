# AI 平台 P4：MCP Client 与图纸接入

> 状态：已落地（未实现模型 tool-calling / Agent loop / 可执行 generic MCP 工具）
> 关联：`docs/ai-platform-plan.md` §6.3 / §P4，`docs/ai-platform-p3.md`（审批门），`docs/diagram-management-mcp.md`（图纸仓库）

## 1. 范围

P4 在既有 P1–P3 平台上引入 **main 进程独占**的 MCP Client，并 RainTool 图纸 MCP 以受控方式接入既有 `AiToolRegistry`。

**已实现**：
- MCP Client Manager（`electron/ai-platform/ai-mcp-manager.ts`）：main 独占的客户端生命周期。
- 配置仓库（`ai-mcp-config-repository.ts`）：`userData/ai/mcp-servers.json`，仅元数据，原子写 0600，读取逐项校验。
- 共享 helpers（`ai-mcp-helpers.ts`）：canonical fingerprint + loopback 校验 + `BoundedStderrSink`。
- RainTool 图纸适配器（`ai-diagram-tools.ts`）：read 直接执行 / write 经 P3 审批门。
- IPC + preload + raintool.d.ts：窄 API，renderer 永不 spawn/connect。
- `McpServersDrawer` UI：状态/工具清单、添加内置/stdio/loopback、激活确认、断开/重连。

**未实现（明确推迟）**：
- 模型 tool-calling / Agent loop。
- 可执行 generic MCP 工具（generic 发现工具仅 inventory-only）。
- remote / OAuth / sampling / elicitation 传输。
- artifact apply / writeback 捷径（write 仍走 P3 审批门，无旁路）。

## 2. 威胁模型

| 威胁 | 缓解 |
|---|---|
| Renderer 直接 spawn/connect MCP | 不可能：无对应 IPC；所有连接由 main 发起 |
| 远程/非 loopback 主机 | `isLoopbackUrl` 拒绝（http only、127.0.0.1/::1/localhost、端口 1–65535、无 credentials/query/hash、raw-URL 遍历加固） |
| OAuth / sampling / elicitation | P4 不实现这些传输；SDK v1 Client 仅用 `connect` + `listTools` |
| shell 注入（stdio） | spawn-without-shell；command 拒绝 shell 元字符；args 拒绝 `;<>&\|`$` + `\n\r`；plain space 允许（直接 argv） |
| stdin 注入 | args 拒绝控制字符；最小化 env（PATH + SYSTEMROOT，永不 process.env） |
| 继承任意 env | 永不接受 caller-supplied env；main 用 `sanitizedEnv()` |
| 服务器 instructions 提升权限 | instructions 丢弃，永不进入 prompt/risk/approvals/roots/policy/modes；不渲染为特权文本 |
| 服务器 labels 影响风险 | 风险由 **app-owned** 适配器映射，非服务器 labels |
| generic 工具可执行 | generic 发现工具 policy=`not-executable`；无 `callTool`/`invoke`/`execute` IPC |
| 图纸 write 绕过审批 | write 适配器 `risk:write`；runtime 经 `buildDiagramApproval` + `ApprovalManager`；无 `apply`/`writeback` 捷径 |
| 图纸 delete/export/path | 适配器不注册这些方法（P4 排除） |
| 配置篡改（mcp-servers.json） | `validateServerEntry` 逐项校验：source↔transport 一致、fingerprint = canonical、绝对 command、clean args、loopback URL；tampered entry 丢弃 |
| 配置变更绕过确认 | `commandFingerprint` 绑定 nonce；config 变更 → fingerprint 变 → pending nonce 失效 |
| renderer 伪造激活 | nonce 由 main `randomUUID` 发放；constant-time 比较；renderer 仅回显，无法铸造 |
| stderr 泄漏 | `BoundedStderrSink` 字节封顶 main 内部诊断；外向 `reason = sanitizeError(error)` only；raw stderr 绝不进 config/event/renderer |
| 失败连接泄漏进程 | failed-connect 关闭半启动 client/transport；`disconnect` idempotent（closing flag） |
| 退出时进程残留 | `before-quit` await `disconnectAll` |

## 3. 服务器受信来源（source）

| source | transport | 持久化 | fingerprint | 确认 |
|---|---|---|---|---|
| `trusted-built-in` | stdio | **不持久化** command/args/url（main 在 connect 时解析 launcher） | `sha256("trusted-built-in:raintool-mcp")` 稳定 label | 无需 renderer 确认（main 直接 enable） |
| `user-stdio` | stdio | 绝对 `command` + clean `args[]` | `sha256(command + "\0" + args.join("\0"))` | renderer 确认（暴露 command+args） |
| `user-loopback` | loopback-http | `url`（http, 127.0.0.1/::1/localhost） | `sha256(canonical {protocol,hostname,port,pathname})` | renderer 确认（暴露 url） |

**源↔transport 一致**：`trusted-built-in`/`user-stdio` 必须 stdio；`user-loopback` 必须 loopback-http。

## 4. 激活确认（`AiMcpConfirmationRequest` / `buildConfirmation`）

main 拥有的单次 TTL nonce（`AI_MCP_CONFIRMATION_TTL_MS` = 2 min），绑定 `commandFingerprint`。字段呈现按源 gated：

- `user-stdio`：暴露 `command` + `args`（exact, ordered），无 `url`。
- `user-loopback`：暴露 `url`（exact endpoint），无 `command`/`args`。
- `trusted-built-in`：返回 `null`（main 直接 enable，不发确认）。

`confirmActivation(serverId, nonce)`：
- 无 pending / wrong serverId → 拒绝
- nonce mismatch（constant-time） → 拒绝
- `now > expiresAt` → 拒绝 + 丢弃 pending
- live `commandFingerprint` ≠ nonce-bound fingerprint（config 变更） → 拒绝 + 丢弃 pending
- 否则：消费 nonce（单次），`enabled = true`，转出 `pending-confirmation`

renderer 无法伪造：它仅收到 nonce + fingerprint 用于显示；`connect()` 在 `pending-confirmation` 时不可达。

## 5. 信任边界

```
Renderer ──(narrow IPC: list/add-stdio/add-loopback/add-bundled/
            build-confirmation/confirm/enable/disable/reconnect/
            delete/list-tools + event)──► Main
                                                    │
                                                    ├─ AiMcpManager（独占 connect）
                                                    │     ├─ checkEligibility
                                                    │     ├─ buildConfirmation / confirmActivation
                                                    │     ├─ buildTransport（stdio: spawn-without-shell +
                                                    │     │                 sanitized env + stderr pipe;
                                                    │     │                 loopback: SDK HTTP transport）
                                                    │     ├─ connect（in-flight guard + failed-cleanup）
                                                    │     └─ sanitizeTools（instructions 丢弃，
                                                    │                       generic = not-executable）
                                                    │
                                                    └─ AiToolRegistry（图纸适配器）
                                                          ├─ read：直接执行
                                                          └─ write：buildDiagramApproval →
                                                                     ApprovalManager → consume → execute
```

**永不跨边界**：tokens、env secrets、raw stderr、server instructions、tool raw payloads。

## 6. stderr 处理

`BoundedStderrSink`（`ai-mcp-helpers.ts`）：
- 字节封顶（`Buffer.byteLength`，非 string.length），`AI_MCP_MAX_STDIO_CAPTURE_BYTES` = 4096。
- UTF-8 边界切片（不拆多字节字符）。
- 保留 TAIL（最近输出）。
- **main 内部诊断 only**：`connect()` catch 的外向 `reason = sanitizeError(error)` **only**；raw stderr 绝不进 `config.error` / `event.error` / renderer。

## 7. lifecycle / 失败 UX

| 事件 | 行为 |
|---|---|
| `enable(serverId)` | pending-confirmation → 拒绝；否则 `connect()` |
| `connect()` | in-flight guard（去重）；failed → 关闭半启动 client/transport；`reason = sanitizeError(error)`；状态 `error` |
| `disconnect()` | idempotent（`closing` flag）；无 active → 仅更新状态 |
| `reconnect()` | pending-confirmation → 拒绝；否则 `disconnect` + `connect` |
| `disconnectAll()` | `before-quit` await；关闭所有 active |
| 事件 | `ai:mcp:event` → `onMcpEvent` → store → UI 刷新（status/toolCount） |

UI 状态：`pending-confirmation` / `disabled` / `connecting` / `connected` / `error` / `disconnected`。错误显示 safe `reason`，无 raw stderr/instructions。

## 8. 图纸适配器

注册 7 个适配器（`registerDiagramTools`）：
- **read**（直接执行）：`diagram.list` / `diagram.get` / `diagram.inspect-revisions`
- **write**（`risk:write`，经 P3 审批门）：`diagram.create` / `diagram.update` / `diagram.duplicate` / `diagram.restore-revision`

排除（P4 不注册）：`delete` / `export`（png/svg）/ path-taking / file / arbitrary MCP call。

`onChanged` 回调镜像 diagram-bridge 的 `onChanged`：write 后 `created`/`updated`/`duplicated`/`restored` → renderer 刷新。

`buildDiagramApproval`：绑定 `contentHash`（canonical input）+ `targetScope`（`diagram:<toolId>`）+ `revision`（diagram id + expectedRevision，stale-target 检测）。

stale-target（`expectedRevision` mismatch） → `DiagramConflictError` 映射为 `stale-target` category，不崩溃。

## 9. 测试

```bash
# MCP manager + helpers + config-repository + confirmation + 9 scenarios + main-boundary
node --test tests/ai-mcp-manager.test.mjs        # 53 项

# 图纸适配器（read 直接执行 / write 审批门 / conflict / 排除 delete/export / onChanged / UUID schema / runtime 审批门 / 审批 expiry+invalid+reuse）
node --test tests/ai-diagram-tools.test.mjs       # 31 项

# 既有图纸仓库 + MCP 集成
npm run test:diagrams

# 全 AI 套件
npm run test:ai

# 构建
npm run build:electron
npx tsc --noEmit
```

覆盖的 9 个必需场景：
1. command 风险确认 + config-change 失效（`scenario 1`）
2. 拒绝 remote/unsafe/stdin-injection 配置（`scenario 2`）
3. discovery instructions 无法改变 policy（`scenario 3`）
4. untrusted generic tool 不可执行（`scenario 4`）
5. RainTool reads 无审批执行（`scenario 5` + 图纸适配器 read 测试 + runtime read 测试）
6. write 发出审批 + 审批前无 side-effect（runtime: `diagram.create` with NO approval → repo 0）
7. reject/expiry（`scenario 7` + runtime: rejected → tool-failed）
8. disconnect/reconnect/failed-connect 清理/idempotency（`scenario 8`）
9. main-boundary 校验（`scenario 9`）

## 10. 依赖与升级

- `@modelcontextprotocol/sdk@1.29.0`（MIT，v1，Node 20 兼容）作为根依赖固定。
- license：`THIRD_PARTY_NOTICES.md` + `LICENSES/modelcontextprotocol-sdk-MIT.txt`。
- **不升级到 SDK v2/main**；不添加 HTTP/OAuth/sampling/elicitation。
- 不修改 vendor server（next-ai-draw-io MCP）的依赖。
- `tests/ai-dep-engine.test.mjs` 断言 MCP SDK v1 已安装（`/^1\./`）。

### 10.1 打包运行时依赖（main 进程 bare-import 解析）

Electron main 为 ESM（`"type": "module"`，`main: dist-electron/main.js`），`tsc` 仅转译不打包，编译产物保留 bare import：

- `dist-electron/ai-platform/ai-provider-registry.js` → `@ai-sdk/openai`、`ai`、`@ai-sdk/provider`
- `dist-electron/ai-platform/ai-mcp-manager.js` → `@modelcontextprotocol/sdk/client/{index,stdio,streamableHttp}.js`
- `dist-electron/ai-platform/ai-diagram-tools.js`、`ai-json-tools.js` → `zod`

这四个运行时依赖（`@ai-sdk/openai@2.0.114`、`@modelcontextprotocol/sdk@1.29.0`、`ai@5.0.216`、`zod@3.25.76`）必须出现在 `package.json` 的 `dependencies` 里：electron-builder 默认会把 `dependencies` 的生产依赖子树（连同传递依赖）复制进 `app.asar`（devDependencies 永不复制），`build.files` 无需额外配置。若任一依赖被移出 `dependencies` 或被 prune，打包后的 main 进程首次加载 AI 平台即 `ERR_MODULE_NOT_FOUND` 崩溃。

回归守卫：`scripts/verify-packaged-ai.mjs` 用 `@electron/asar` 的 `listPackage` 断言四个依赖根的 `package.json` 存在于 `app.asar` 内——此前该脚本只校验文件存在 + MCP launcher，从不验证 main 进程依赖解析。`npm run dist` / `npm run verify:package:ai` 任一缺失都会抛错。

### 10.2 图纸 write 审批生命周期（expiry / invalid / reuse）

`tests/ai-diagram-tools.test.mjs` 在既有 approve/reject/cancel/read 之上新增：

- **runtime 级 expiry**：`AiRuntime` 内部 `approvalManager.propose()` 返回的是 manager map 中的 live token 引用；测试用 wrapper 捕获该引用，在 `decide(true)` 时把 `expiresAt` 置为过去。runtime 随后的 `consume()` 观察到过期 → `tool-failed`（category `approval-expired`），repo=0、onChanged=0，run 以单个 `failed` terminal 干净结束。无需在 production 加 test-only TTL hook。
- **manager 级 invalid**（diagram 专属，经 `buildDiagramApproval`）：tampered `contentHash` / swapped `targetScope` / stale `revision` / cross-tool `toolId` mismatch → `consume` 拒绝，无副作用。
- **manager 级 reuse**：`consume` 成功后第二次 `consume` 返回 `{ok:false, status:'used'}`——单次有效，图纸 write 不可被重放。

runtime 始终用自己重建的 `approvalReq` 调 `consume()`，因此 binding mismatch 不可能经正常 runtime 路径发生——该契约在 manager 层强制。

## 11. 推迟的传输

P4 不实现，未来阶段需独立审核：
- remote HTTP（非 loopback）
- OAuth / Bearer token 认证
- sampling（服务器请求模型）
- elicitation（服务器请求用户输入）
- HTTPS / TLS（loopback 也不启用，简化证书面）

这些传输引入新的出网/认证/交互面，需独立的威胁模型 + 审批策略，不在 P4 范围。
