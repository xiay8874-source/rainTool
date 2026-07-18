# RainTool Git 工作台

> 关联：[`docs/git-workbench-plan.md`](./git-workbench-plan.md)（实施方案）、[`docs/ai-platform-plan.md`](./ai-platform-plan.md)（AI 平台）、[`docs/ai-platform-p4.md`](./ai-platform-p4.md)（MCP/平台 P4）

RainTool 内置的本地 Git 操作台。覆盖开发者日常最频繁的本地工作流：查看改动、按文件暂存/取消暂存、Diff 预览、基于**已暂存**内容生成可编辑的提交说明、人工确认提交，以及受限的远端同步（fetch / `pull --ff-only` / push）。

---

## 1. 支持的工作流

| 工作流 | 说明 | 入口 |
|---|---|---|
| 打开仓库 | 选择本地仓库并记录到「最近使用」列表；解析顶层目录、当前分支、上游、ahead/behind。 | 工具栏「打开仓库」 |
| 状态刷新 | `git status --porcelain=v2 -z -b` 解析；分栏展示已暂存 / 未暂存 / 未跟踪；显示 operation（merge/rebase/...）。 | 自动刷新 + 手动刷新 |
| 暂存 / 取消暂存 | `git add -- <paths>` / `git restore --staged -- <paths>`；路径经 `validatePaths` 校验（拒绝 NUL/绝对路径/`..`/快照外）。 | 文件行操作按钮 |
| 丢弃工作区改动 | `git restore --worktree -- <paths>`，**仅已跟踪未暂存**；不触碰暂存区、不删未跟踪文件；UI 逐文件确认 + 不可撤销警告。 | 文件行「丢弃」按钮 |
| Diff 预览 | 返回完整 `original` / `modified` 文本（非 patch），Monaco `DiffEditor` 渲染；支持 unified / split 切换；2 MiB / 50,000 行上限。 | 点击文件行 |
| 身份 | `git config user.name` / `user.email`；未配置返回 null。 | 提交区显示 |
| 人工提交 | `git commit`；前置校验：身份、暂存数 > 0、operation=normal、subject 非空；标题即确认门（无独立弹窗）。 | 提交区「提交」 |
| Fetch | `git fetch --prune`；返回刷新后的 status（更新 ahead/behind）。 | 同步区「Fetch」 |
| Pull | `git pull --ff-only`；非快进拒绝（**不产生 merge commit**），错误码 `REMOTE_DIVERGED`。 | 同步区「Pull」 |
| Push | `git push`（仅已配置 upstream 的当前分支）；无 upstream 拒绝 `NO_UPSTREAM`，UI 引导从 `git remote` 列表明确选择远端后调用 `git push -u <remote> <branch>`。**无 force push。** | 同步区「Push」 + 首次推送对话框 |
| 分支 | 只读展示当前分支、上游、ahead/behind、detached 状态；**不提供**分支创建/删除/切换/merge/rebase。 | 状态栏 |

### 1.1 闭合 IPC 契约（closed named operations）

所有 Git 操作通过 main 进程的 `GitRunner` 闭合接口执行——**渲染层只传 `repositoryId`（不透明 token）+ 结构化参数，从不传 cwd / argv / shell / diff 文本**。`GitRunner` 的公开方法是固定的命名操作白名单：

```
revParseTopLevel, revParseHead, statusPorcelainV2, configGet,
add, restoreStaged, showBlob, catFileSize,
commit, fetch, pullFfOnly, push, pushUpstream,
restoreWorktree, remoteList,
diffCachedStat, diffCachedPatch          # Task 4: AI 提交说明上下文
```

- `spawn('git', args, { shell: false, cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })`——永不 `exec`，永不 `shell:true`。
- pathspec 一律在字面量 `--` 之后；NUL / 绝对路径 / `..` / 快照外路径一律拒绝。
- **结构上不可达**：`reset --hard` / `push --force` / `merge` / `rebase` / `clean` / `branch -D` / `stash` / `checkout` 没有对应方法——不是「禁用」而是「不存在」。
- 每个 IPC handler 首先调用 `assertTrustedRenderer(event)`；错误经 `toIpcError` 脱敏（不泄露原始 stderr/env/token）。
- 不使用 isomorphic-git。

白名单由 `tests/git-runner.test.mjs` 的「public method set is exactly the closed allowlist」测试强制保证——新增方法必须同步更新该测试，否则失败。

---

## 2. AI 提交说明生成（Task 4）

基于**当前已暂存**内容，调用既有 AI 平台的 Provider/Profile/凭据，一次性生成结构化提交说明（`subject` / `body` / `rationale`），写入既有提交输入框供用户自由编辑后**人工**提交。

### 2.1 隐私 / 安全边界（核心契约）

```
渲染层 (GitWorkbench store)              Main 进程                          Provider
────────────────────────────              ─────────────                          ────────
gitProposeCommitMessage                  git:propose-commit-message
  └─ 只传 repositoryId  ──────────►        assertTrustedRenderer
  + modelProfileId                          └─ GitRepositoryService.collectStagedContext(repositoryId)
                                                 ├─ 新鲜 getStatus → 仅 staged 文件
                                                 ├─ isSecretPath(path 或 originalPath)
                                                 ├─ catFileSize :0 → 二进制/过大嗅探
                                                 ├─ diffCachedPatch（单文件 80 KiB head 上限，闭合 argv）
                                                 ├─ isRestrictedContent（PEM/.env 赋值/AWS 密钥，去 diff 前缀）
                                                 └─ 80 KiB / 12,000 行最终聚合上限（headers + 文件列表 + 注记 + patch）
                                            └─ AiRuntime.proposeCommitMessage({ modelProfileId, system, userPrompt })
                                                 ├─ profileRepository.get + credentialVault.get（既有，safeStorage）
                                                 ├─ providerRegistry.streamChat（既有，一次性）
                                                 └─ zod 严格校验 finalText JSON
  ◄── 返回 { subject, body, rationale } 或抛 [git:CODE]
  └─ setCommitSubject / setCommitBody（既有 setter；用户自由编辑）
```

**渲染层只传 `repositoryId` + `modelProfileId`**——不传 cwd、argv、路径、diff 文本、模型名或 API key。所有 Git 工作走闭合服务；所有 Provider 配置是既有 AI 平台。

#### 2.1.1 仅已暂存快照
- `collectStagedContext` 读取**新鲜** `getStatus().staged`；未暂存 / 未跟踪文件**永远不进入**上下文。
- 前置门：`operation === 'normal'`（否则 `MERGE_OR_REBASE_IN_PROGRESS`）、`staged.length > 0`（否则 `NO_STAGED_CHANGES`）。

#### 2.1.2 路径排除（重命名/复制检查 originalPath）
匹配 `isSecretPath` 的文件只发送**文件名 + 状态**，永不发送 patch：
- `.env`、`*.env`（`.env.local` / `prod.env` 等），但**不**匹配 `env.d.ts` / `*.env.d.ts`。
- `*.pem`、`*.key`、`*.p12`、`*.keystore`。
- `id_rsa*`（通配：`id_rsa` / `id_rsa.pub` / `id_rsa_backup` / `id_ed25519_github` / `id_ecdsa_sk` / `id_dsa.old` 等——匹配前缀，非精确名）。
- 任意包含 `secrets/` 段的路径。

**重命名/复制防绕过**：对 staged rename/copy，**同时**检查 `f.path` 与 `f.originalPath`（`isSecretPath(f.path) || isSecretPath(f.originalPath ?? '')`）。`secrets/token.json → data/config.json` 这种把敏感文件改名到无害目的地的操作，仍因 originalPath 匹配而被排除。

#### 2.1.3 内容防御（defense-in-depth）
即便路径未命中 `isSecretPath`，`isRestrictedContent(patch)` 仍会扫描 patch 文本：
- PEM 私钥块（`-----BEGIN ... PRIVATE KEY-----`）。
- `.env` 风格赋值（`KEY=value`，KEY 含 key/token/secret/password/passwd/pwd/credential）。
- AWS 访问密钥 ID（`AKIA...`）、AWS 风格密钥。
- **去 diff 前缀**：扫描前剥离每行 `+`/`-`/空格前缀，确保 `+OPENAI_API_KEY=sk-...` 这种 patch 行也能被 `^[ \t]*` 锚点命中。

命中即排除（文件名 + 状态 only，patch 不发送）。

#### 2.1.4 80 KiB / 12,000 行最终上限
**上限约束最终外发 prompt 的整体**——包括 headers、文件列表、状态注记、路径**和** patch 文本，而非仅 patch 字节：
- 数千个文件名（或数千条「已排除/二进制」注记）**不能**绕过上限。
- 聚合计数器累加每一段；达到上限后剩余文件降级为文件名+状态（记入 `cappedPaths`，`truncated=true`）。
- **最终硬保证**：在 `sections.join('\n\n')` 之后，对**实际组装字符串**测量 `Buffer.byteLength(prompt, 'utf8')` 与 `prompt.split('\n').length`，迭代修剪到**完整行边界**同时满足两个上限。不依赖内部计数器；`totalBytes`/`totalLines` 由最终字符串重算。

#### 2.1.5 Profile / 凭据使用
- 复用既有 AI 平台的 `AiProviderRegistry.streamChat` + `AiModelProfileRepository.get(id)` + `AiCredentialVault`（safeStorage）。
- **不新增**模型/key 配置；渲染层从既有 AI store 读 `activeProfileId` 惰性传入。
- key 永不经明文、永不传渲染层/日志。

#### 2.1.6 提案可编辑、永不自动暂存/提交/推送
- 成功后把 `subject` / `body` 写入既有 `commitSubject` / `commitBody` 输入框——用户自由编辑，再用既有「提交」按钮**人工**提交。
- **绝不**自动 `git add` / `commit` / `push`。store 测试 `success → subject/body filled, NO gitCommit call` 强制保证。
- 失败时（provider 故障 / schema 无效 / 超时）`commitSubject` / `commitBody` **保持原样**（不部分填充），`error` / `errorCode` 上报。

#### 2.1.7 结构化输出 + 严格校验
- 模型输出经 `parseCommitProposal` 容错解析（去 ```` ```json ```` 围栏、提取平衡 `{...}`、`JSON.parse`）后用 zod `.strict()` `safeParse` 校验：
  - `subject`：1–200 字符；`body`：≤4000 字符；`rationale`：1–1000 字符。
  - 多余字段（`type` / `scope` / `confidence` 等）一律拒绝。
- `parseCommitProposal` **永不抛异常**——任何失败返回 `{ ok: false, reason }`，调用方 fail-safe。

---

## 3. 前置条件与限制

### 3.1 前置条件
- 系统已安装 `git`（PATH 可达）。缺失时打开仓库返回 `GIT_NOT_FOUND`。
- 目标路径是 Git 仓库顶层或子目录（`git rev-parse --show-toplevel` 成功）。
- 提交前需配置 `user.name` + `user.email`（仓库级或全局级）。
- Push/Pull 需远端已配置且当前分支有 upstream（首次推送走 `pushUpstream` 显式选择远端）。
- AI 提交说明需在 AI 设置中配置并选择一个 Provider/Profile。

### 3.2 限制（有意为之）
- **无 force push / `reset --hard` / `merge` / `rebase` / `clean` / `branch -D`**——结构上不可达。
- Pull 仅 `--ff-only`，非快进拒绝（不产生 merge commit）。
- Diff 单侧上限 2 MiB / 50,000 行；超出返回 `too_large`。
- AI 提交说明的 staged 上下文上限 80 KiB / 12,000 行（最终 prompt 整体）。
- 提交标题 ≤ 200 字符（UI 软限 400，服务端硬限 200）。
- 无 stream 提案文本到 UI（一次性收集 `finalText` 后返回；streaming UX 是后续项）。
- 无 IPC 层 AbortSignal（沿用 Task 3 先例：`streamChat` 30s 超时；取消 UI 是后续项）。

---

## 4. 故障排查

| 现象 / 错误码 | 原因 | 处理 |
|---|---|---|
| `GIT_NOT_FOUND` | 系统 PATH 无 `git` | 安装 git 并重启应用 |
| `NOT_REPOSITORY` | 选定路径不是仓库 | `git init` 或选择正确仓库根 |
| `MERGE_OR_REBASE_IN_PROGRESS` | 存在 `MERGE_HEAD` / `REBASE_HEAD` 等 | 在终端完成或中止 merge/rebase 后再操作 |
| `IDENTITY_MISSING` | `user.name` / `user.email` 未配置 | `git config user.name "..." && git config user.email "..."`（仓库级或全局级） |
| `NO_STAGED_CHANGES` | 提交/生成说明时无已暂存文件 | 先 `git add` 或用工作台暂存按钮 |
| `EMPTY_COMMIT` | subject 为空或 >200 字符 | 填写非空标题（≤200 字符） |
| `HOOK_FAILED` | pre-commit hook 退出非零 | 修复 hook 或按 hook 输出处理 |
| `NO_UPSTREAM` | push 时当前分支无 upstream | 用首次推送对话框从 `git remote` 列表选择远端 |
| `REMOTE_DIVERGED` | pull 非快进 / push 被拒 | fetch 后 rebase 或合并，再重试 |
| `REMOTE_AUTH_FAILED` | 远端认证失败（HTTPS 密码/token 或 SSH key） | 配置凭据助手 / SSH key / PAT |
| `AI_UNAVAILABLE` | AI 平台未初始化或未选 Profile | 在 AI 设置中配置并选择一个 Provider |
| `AI_PROVIDER_FAILED` | 模型调用失败（网络 / 限流 / key 无效） | 检查 Profile 配置与 key，重试 |
| `AI_SCHEMA_INVALID` | 模型输出不符合 JSON schema | 重试（弱模型可能不稳定）；或手写提交说明 |
| `COMMAND_TIMEOUT` | git/模型操作超时（30s） | 检查网络/仓库大小；大仓库可能需要调优 |

错误经 `toIpcError` 脱敏——`[git:CODE] message` 格式透传，原始 stderr / env / token **永不**回渲染层。

---

## 5. 升级与维护指南

### 5.1 闭合 IPC 契约维护
- 新增 Git 操作 = 在 `GitRunner` 加**命名方法**（固定 argv，无 caller-supplied subcommand/flag）+ 更新 `tests/git-runner.test.mjs` 白名单测试 + 加 service 方法 + IPC handler + preload + 类型声明。
- **永不**引入接受任意 argv 的方法；`runGit` / `spawnGit` / `GitArgs` 已删除且不可回归（测试强制）。
- 新增 AI 上下文来源 = 在 `collectStagedContext` 内加闭合采集步骤，**不**让渲染层传 diff/paths。

### 5.2 回归测试套件
| 套件 | 命令 | 覆盖 |
|---|---|---|
| Git Runner + Service | `node --test tests/git-runner.test.mjs` | 闭合白名单、diff、porcelain 解析、commit/fetch/pull/push 门、discard、collectStagedContext（staged-only 隔离 / 秘密路径 / originalPath 重命名 / id_rsa 通配 / 聚合上限 / 二进制） |
| Store | `node --test tests/git-workbench-store.test.mjs` | selectFile/stage/unstage 隔离、canCommit 规则、proposeCommitMessage（可编辑交接 / 错误不部分填充 / 守卫 / 重入） |
| Proposer 纯模块 | `node --test tests/git-commit-proposer.test.mjs` | isSecretPath（含通配）、buildStagedContextPrompt（最终上限 / thousands 文件名 / 行上限绕过 / 双上限同时突破）、parseCommitProposal（严格/容错/永不抛）、isRestrictedContent |
| MCP | `npm run verify:mcp` | MCP 工具注册 |
| 图纸 | `npm run test:diagrams` | 图纸仓库 + MCP 集成 |

一键全量：`npm run test:git && npm run verify:mcp && npm run test:diagrams`。

### 5.3 依赖 / 许可证更新
- 新增依赖后更新 `THIRD_PARTY_NOTICES.md` + 对应 `LICENSES/*.txt`。
- 许可证变更（尤其 GPL/AGPL）需评估与 Electron 分发的兼容性。
- `npm audit` 发现高危项需在发版前处理或记录豁免理由。

### 5.4 发版前检查清单
- [ ] `npx tsc -b` 零错误
- [ ] `npm run build:electron` 成功
- [ ] `npm run build`（renderer）成功
- [ ] `npm run test:git` 全绿（允许已知的环境相关 skip）
- [ ] `npm run verify:mcp` 通过
- [ ] `npm run test:diagrams` 全绿
- [ ] 闭合白名单测试未引入任意 argv 方法
- [ ] 无新 `.env` / 密钥文件提交（`.gitignore` 已覆盖）
- [ ] 新增 IPC handler 有 `assertTrustedRenderer`
- [ ] `THIRD_PARTY_NOTICES.md` + `LICENSES/` 已同步

### 5.5 安全审计要点
- 渲染层**永不**持有 cwd / argv / API key / 原始 stderr。
- AI 上下文**仅**来自新鲜 staged 快照；路径排除（含 originalPath）+ 内容防御 + 最终双上限三层。
- 提案**永不**自动暂存/提交/推送。
- key 经 safeStorage，永不落明文/日志/渲染层。

---

## 6. 相关文档

- [`docs/git-workbench-plan.md`](./git-workbench-plan.md)——实施方案（目标、边界、Diff/commit/sync 设计、AI 提交说明协议）
- [`docs/ai-platform-plan.md`](./ai-platform-plan.md)——通用 AI 平台（多模型/凭据/对话/上下文/工具/审批/审计）
- [`docs/ai-platform-p4.md`](./ai-platform-p4.md)——AI 平台 P4（MCP Client 与图纸接入）
- [`docs/diagram-management-mcp.md`](./diagram-management-mcp.md)——图纸仓库 MCP
