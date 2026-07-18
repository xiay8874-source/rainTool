# RainTool Git 工作台实施方案

## 1. 目标与边界

在 RainTool 中新增一个独立的 **Git 工作台**，服务开发者日常最频繁的本地 Git 操作：查看改动、按文件暂存、预览 Diff、生成提交说明、提交，以及有限的远端同步与分支操作。

### 1.1 第一版必须交付

1. 选择本地仓库并记录最近使用的仓库。
2. 解析当前分支、上游、ahead/behind、工作区状态。
3. 分栏查看已暂存、未暂存、未跟踪文件；支持按文件暂存、取消暂存、丢弃本地改动。
4. 预览文本 Diff（左右对比与统一模式）；正确处理新增、删除、重命名、二进制和过大文件。
5. 仅根据**已暂存改动**生成可编辑的 Conventional Commit 提交说明。
6. 人工确认后提交；展示可理解的 Git 错误。
7. Fetch、Pull（仅 `--ff-only`）与 Push（不支持 force push）。

### 1.2 明确不做（第一版）

- 不做强制推送、`reset --hard`、自动提交、自动推送、交互式 rebase、cherry-pick。
- 不做行级或区块级暂存；第二期再通过受控 patch 实现。
- 不做内置 GitHub Token 登录；复用系统 Git 的 SSH、credential helper、`gh` 登录状态。
- 不把 CodeDelta 整体嵌入 RainTool；它属于后续“历史结构分析”能力。
- 不读取或复用 `vendor/next-ai-draw-io` 的模型设置、浏览器 localStorage 或 API Key。

### 1.3 成功标准

用户能在不打开终端的情况下完成：选择仓库 → 选择要提交的文件 → 阅读 Diff → AI 生成/编辑提交信息 → 提交 → Push；全程不会执行未展示给用户的破坏性 Git 命令，也不会把未暂存或敏感文件内容发给模型。

## 2. 产品与交互设计

### 2.1 入口与标签页

- 在 `src/components/tools/catalog.ts` 新增 `git-workbench` 工具，归入新分类 `开发协作`（或 `Git`，二选一并保持后续工具一致）。
- 该工具复用已有普通标签页机制；**不得修改 tabs 的通用数据结构**。
- 打开时显示仓库选择空态；选中仓库后保持在 Git 工作台内部状态中，最近仓库持久化到 `~/raintool/git-recent-repos.json`。

### 2.2 主界面

```text
┌ 仓库名称 / 路径 ─ 分支 ─ 上游 ─ ↑ahead ↓behind ─ 刷新 ─ Fetch / Pull / Push ┐
├───────────────┬────────────────────────────────────┬────────────────────────────┤
│ 变更文件       │ Diff 预览                            │ 提交                         │
│ 已暂存 (n)     │ 文件名、状态、大小                  │ 已暂存 n 个文件              │
│ 未暂存 (n)     │ [统一] [左右]                       │ [AI 生成]                   │
│ 未跟踪 (n)     │ Monaco Diff Editor / 二进制摘要      │ type(scope): subject         │
│                │                                     │ body                         │
│ 文件操作菜单    │                                     │ [提交]                       │
└───────────────┴────────────────────────────────────┴────────────────────────────┘
```

### 2.3 文件状态与操作

- 状态解析使用 `git status --porcelain=v2 -z --branch`，不得解析给人看的普通 `git status` 文本；必须支持空格、中文、换行等合法文件名。
- 一个文件可同时有 index 状态和 worktree 状态，UI 要分别显示并可分别预览：
  - **已暂存**：`HEAD` 对比 index。
  - **未暂存**：index 对比工作区。
  - **未跟踪**：空文件对比工作区。
- 第一版只允许文件级 `stage / unstage / discard`。`discard` 必须在对话框中显示文件名、操作不可撤销提示，并按状态选择安全命令：
  - 未暂存已跟踪文件：`git restore --worktree -- <path>`。
  - 未跟踪文件：仅允许“移动到废纸篓/删除”作为后续增强；第一版不提供删除按钮。
  - 已暂存改动不得由“丢弃未暂存”影响。
- 默认不展示 ignored 文件；提供“显示 ignored”开关作为后续项。

### 2.4 Diff 行为

- 默认统一视图，支持切换左右视图；使用 Monaco Diff Editor，不自行实现行对齐算法。
- 服务端同时返回：`patch`（便于轻量预览）、原始文本、修改后文本、语言、截断信息。
- 文本展示上限：单文件 2 MiB 或 50,000 行；超限展示统计与“文件过大，未加载全文”。
- 二进制文件、LFS pointer、不可解码文本不传到 Monaco；展示大小、状态和“二进制文件不可比较”。
- 处理新增、删除、重命名、子模块与无 `HEAD` 的初始仓库；初始提交的旧版本统一视为空内容。

### 2.5 AI 提交说明

#### 输入范围

只读取已暂存差异，按照以下顺序构建请求：

1. 仓库名、当前分支、用户选择的语言、用户自定义提交规范。
2. `git diff --cached --stat` 与文件状态列表。
3. 已暂存文本 patch，按文件分块并限定总量（建议 80 KiB 或 12,000 行）。
4. 遇到二进制、超大文件、疑似敏感文件时只给模型文件名和统计，不给内容。

默认排除 `.env`、`.pem`、`.key`、`id_rsa*`、`*.p12`、`*.keystore`、`secrets/**`，并额外检查常见 token 模式。若用户显式希望包含被排除内容，仍只允许发送文件摘要，不能解除该保护。

#### 输出协议

模型必须输出 JSON，不允许直接执行 Git 操作：

```json
{
  "type": "feat",
  "scope": "git",
  "subject": "add staged change preview",
  "body": ["show index and worktree diffs separately"],
  "breaking": false,
  "confidence": "high",
  "notes": ["Only staged files were analyzed"]
}
```

渲染层对 JSON 做 schema 校验；失败时显示原始回答并允许重新生成，绝不自动填充为可提交文本。用户始终可以编辑 subject 和 body，最终提交信息以用户编辑后的值为准。

#### 接入通用 AI 平台

Git 不维护独立的模型设置、密钥或聊天逻辑。它接入 `docs/ai-platform-plan.md` 定义的 AI Platform：

- Provider、Model Profile、API Key、会话、审批和审计由 AI Platform 统一负责。
- Git 只贡献“已暂存变更摘要 / 已过滤 Diff”上下文，以及 `read`、`propose`、`write` 风险分级工具。
- Git 的 AI 入口必须展示“仅已暂存内容会发送给当前 Provider”；敏感文件保护仍由 Git 服务先执行，再交给 Context Vault。
- 模型调用失败只影响生成，不影响 Git 工作台的手动暂存、提交和同步。

### 2.6 提交、远端和分支

- 提交按钮启用条件：至少有一个 staged 文件、Git identity 已配置、提交 subject 非空。
- 执行前显示“将提交到 `branch`、共 n 个已暂存文件”；成功后刷新状态并显示短 SHA。
- `Pull` 固定使用 `git pull --ff-only`，遇到非快进提示用户在终端或后续冲突工作流中处理，禁止隐式 merge。
- `Push` 仅允许普通 `git push`；若无 upstream，引导用户明确选择 `origin/<branch>` 后执行 `git push -u origin <branch>`。禁止拼接用户输入到 shell。
- 第二期分支页：创建、切换、删除本地分支；删除需禁止当前分支和未合并分支的默认删除。

## 3. 技术架构

### 3.1 总体原则

1. Git 只在 Electron 主进程执行；React 渲染层不能调用 `child_process`、读取仓库文件或持有凭据。
2. 所有 Git 命令由受控的 `GitRunner` 生成：`spawn('git', args, { shell: false })`，不使用 `exec`，不接受渲染层传入的任意命令、选项或 cwd。
3. 每个 IPC handler 调用现有 `assertTrustedRenderer(event)`。
4. UI 发入的路径必须匹配本次 `status` 返回的仓库相对路径；实际命令始终追加 `--` 作为 pathspec 分隔符。
5. 同一仓库的可变操作串行化；操作期间暂停后台刷新，完成后统一 refresh。

### 3.2 推荐模块

```text
electron/
  git-types.ts                # 共享 DTO、错误码、AI 请求/响应 schema
  git-runner.ts               # 参数白名单、spawn、超时、输出上限、错误归一化
  git-repository-service.ts   # repo 发现、status、diff、stage、commit、remote
  git-ai-service.ts           # 过滤 staged diff、调用模型、校验输出
  git-secret-store.ts         # safeStorage 加解密；绝不暴露 key

src/components/tools/git-workbench/
  index.tsx                   # 工具入口与仓库空态
  GitWorkspace.tsx            # 顶部状态和三栏布局
  ChangeList.tsx              # staged/unstaged/untracked 树
  DiffPanel.tsx               # Monaco Diff Editor 与降级视图
  CommitPanel.tsx             # AI 生成、编辑、确认提交
  RemoteActions.tsx           # fetch/pull/push 的可见状态
  RepoPicker.tsx              # 目录选择、最近仓库

src/store/git-workbench.ts    # 仅 UI 会话状态与最近仓库元数据，不保存密钥
tests/git-runner.test.mjs
tests/git-repository-service.test.mjs
tests/git-ai-redaction.test.mjs
docs/git-workbench.md         # 用户指南、权限和故障排查
```

### 3.3 不依赖第三方 Git 实现

第一版使用系统 `git`，而不是以 `isomorphic-git` 重实现 Git。这样能尊重用户已有的 hooks、SSH、LFS、子模块、GPG 签名和 credential helper。`simple-git` 可以作为命令包装参考，但不能把它的自由命令接口直接暴露给 IPC；优先维护本项目自己的窄 `GitRunner`。

新增前端依赖：`monaco-editor` 和 `@monaco-editor/react`。新增依赖必须记录在 `THIRD_PARTY_NOTICES.md` 与打包许可证目录。

### 3.4 IPC 合约

所有返回值使用可显示给用户的结构化错误，不把原始命令行、环境变量、Token 或完整 stderr 无限制回传。

```ts
type GitErrorCode =
  | 'GIT_NOT_FOUND' | 'NOT_REPOSITORY' | 'REPOSITORY_UNSAFE'
  | 'IDENTITY_MISSING' | 'NO_STAGED_CHANGES' | 'EMPTY_COMMIT'
  | 'MERGE_OR_REBASE_IN_PROGRESS' | 'CONFLICT'
  | 'AUTH_REQUIRED' | 'REMOTE_DIVERGED' | 'HOOK_FAILED'
  | 'COMMAND_TIMEOUT' | 'COMMAND_FAILED'

interface GitRepositorySummary {
  root: string
  displayName: string
  branch: string | null
  headSha: string | null
  upstream: string | null
  ahead: number
  behind: number
  isDetached: boolean
  operation: 'normal' | 'merge' | 'rebase' | 'cherry-pick' | 'bisect'
}

interface GitStatus {
  repository: GitRepositorySummary
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
}

interface GitDiffRequest {
  repositoryId: string
  path: string
  source: 'staged' | 'unstaged' | 'untracked'
  view: 'unified' | 'split'
}

interface GitDiffResult {
  kind: 'text' | 'binary' | 'too_large' | 'submodule'
  patch?: string
  original?: string
  modified?: string
  language?: string
  truncated?: boolean
  summary: string
}
```

IPC 方法必须限制为：

```text
git:choose-repository
git:list-recent-repositories
git:open-repository
git:refresh-status
git:get-diff
git:stage-files
git:unstage-files
git:discard-worktree-files
git:commit
git:fetch
git:pull-ff-only
git:push
git:get-ai-settings
git:save-ai-settings
git:generate-commit-message
```

`git:generate-commit-message` 只接收 `repositoryId` 和用户偏好，服务端自行重新读取 staged 内容，不能相信渲染层上传的 diff。

## 4. 命令映射与安全规则

| 场景 | 受控命令 |
|---|---|
| 验证仓库 | `git rev-parse --show-toplevel` |
| 状态 | `git status --porcelain=v2 -z --branch` |
| 暂存文件 | `git add -- <path...>` |
| 取消暂存 | `git restore --staged -- <path...>` |
| 丢弃工作区改动 | `git restore --worktree -- <path...>` |
| 已暂存 patch | `git diff --cached --no-ext-diff --unified=3 -- <path>` |
| 未暂存 patch | `git diff --no-ext-diff --unified=3 -- <path>` |
| 提交 | `git commit -m <subject> [-m <body>]` |
| 更新远端 | `git fetch --prune` |
| 拉取 | `git pull --ff-only` |
| 推送 | `git push` 或首次明确的 `git push -u origin <branch>` |

- 进程环境设定 `GIT_TERMINAL_PROMPT=0`，让缺少凭据时稳定返回 `AUTH_REQUIRED`；系统 credential helper/SSH 已缓存凭据仍可工作。
- stdout/stderr 各截断为 16 KiB；日志只保留命令名、退出码和脱敏后的诊断。
- 只允许工作树内的相对路径，拒绝绝对路径、`..`、NUL 和不在 status 快照中的路径。
- 状态、Diff、提交前都检查 merge/rebase/cherry-pick 状态；进行中时禁用会扩大冲突的操作并给出恢复建议。
- 不覆盖用户的 Git config，不写 Git credentials，不修改 remote URL。

## 5. 实施任务（可直接交给 ZCode）

### Task 0：基线与约束

1. 基于最新 `main` 新建 `codex/git-workbench` 分支。
2. 阅读 `electron/main.ts` 的 `assertTrustedRenderer`、现有 `preload.ts`、`src/types/raintool.d.ts`、工具目录与打包脚本。
3. 不改动 AI Draw.io、图纸管理、MCP 或通用 tabs 数据结构。
4. 为所有新增依赖和许可证更新 notices；不要安装 `isomorphic-git` 或把 Git 可执行文件打包进 app。

验收：`git diff --check` 通过，既有 `npm run verify:mcp` 与 `npm run test:diagrams` 仍通过。

### Task 1：GitRunner 与仓库状态

1. 实现 `git-runner.ts`：固定命令、`shell: false`、timeout、Abort、输出截断、错误码映射。
2. 实现仓库目录选择、`rev-parse` 验证、最近仓库持久化与 `status --porcelain=v2 -z --branch` 解析。
3. 实现 repositoryId 到已验证 root 的内存映射，拒绝未知或过期 repositoryId。
4. 新增 preload / `.d.ts` / main IPC，并对所有 Git handler 使用 `assertTrustedRenderer`。
5. 创建临时 fixture repo 测试：中文路径、空格路径、未跟踪、删除、重命名、无 Git、非仓库、Git 不存在。

验收：单元测试覆盖 porcelain v2 解析；TypeScript build 通过；渲染层拿不到任意 shell 执行能力。

### Task 2：变更列表与 Diff

1. 新增 `git-workbench` 工具入口、Zustand 会话 store、仓库选择空态和顶部仓库状态。
2. 做 staged / unstaged / untracked 三组文件列表及文件级 stage、unstage。
3. 实现 diff 获取与 Monaco 显示；处理空内容、删除、二进制、超限、首次提交、重命名。
4. 所有写操作完成后串行 refresh；失败时保持旧状态并显示可读错误。

验收：用 fixture repo 手动验证新增、修改、删除、重命名、二进制、文件过大；切换文件不会卡顿或串图。

### Task 3：提交与远端同步

1. 实现提交面板，显示 staged 文件数、author identity、提交 subject/body 校验。
2. 提交、fetch、pull `--ff-only`、push 的主进程实现和可取消加载状态。
3. 无上游、身份缺失、hook 失败、认证失败、ahead/behind、merge/rebase 进行中均展示专用文案。
4. 丢弃未暂存工作树改动需二次确认；未跟踪文件不提供删除。

验收：本地 bare remote fixture 上完成 commit/fetch/push；非快进 pull 不产生 merge commit；操作失败后应用没有卡死。

### Task 4：接入 AI Platform 的提交说明

前置条件：`docs/ai-platform-plan.md` 的 P3 已审核通过。

1. 实现 staged-only Context contribution、敏感文件排除、内容总量限制和 commit proposal artifact schema。
2. 加入“生成依据：仅已暂存文件 n 个”的 UI 提示；生成结果只能填充编辑器，不能触发 commit。
3. 注册 Git read/propose 工具，不注册 push、discard 等 dangerous 工具。
4. 添加 redaction 测试，证明 `.env`、私钥和 token 模式不会离开 Git 服务或 Context Vault。

验收：模型不可用、响应非 JSON、网络超时、无暂存内容都可恢复；密钥不出现在 DevTools、IPC 返回、日志或持久化明文中。

### Task 5：文档、回归与发布

1. 完成 `docs/git-workbench.md`：使用方法、权限、隐私、已知限制、故障排查、如何安全升级依赖。
2. 更新项目 README 的工具列表与第三方 notices。
3. 运行 `npm run build`、`npm run build:electron`、`npm run verify:mcp`、`npm run test:diagrams` 和新增 Git 测试。
4. 打包安装后，使用真实小型 Git 仓库回归：中文路径、hooks、SSH 已登录与未登录、离线状态。

## 6. 测试矩阵与验收清单

| 场景 | 必须结果 |
|---|---|
| 无 Git / 非 Git 目录 | 不崩溃，提示安装 Git 或选择仓库 |
| 未暂存文本改动 | 能显示 index → worktree Diff，能暂存 |
| 已暂存文本改动 | 能显示 HEAD → index Diff，AI 可读取 |
| 未跟踪文件 | 空 → worktree Diff，暂存后移入 staged |
| 中文、空格、重命名路径 | 列表、Diff、暂存、提交均正确 |
| 二进制和超大文件 | 不加载全文、不传模型、页面可操作 |
| `.env` / private key | AI 请求中无文件内容，界面有排除说明 |
| Git hook 失败 | 不产生提交，显示 hook 诊断 |
| merge/rebase 中 | 禁用提交、pull、push 等危险操作并给出说明 |
| Push 未认证 | 不弹终端、不泄密，提示配置 SSH/credential helper |
| AI 非 JSON / 超时 | 不影响手动编辑、手动提交 |
| 退出应用 | 无正在写入的设置损坏；Git 子进程可被清理 |

## 7. 后续演进

### 第二期：高频效率

- 行/区块级暂存（基于校验后的 `git apply --cached` patch）。
- 提交历史图、比较两个提交、文件历史、Blame、stash。
- 分支管理、工作树（worktree）与 PR 状态（可选依赖 `gh`）。
- 提交模板、团队 commit 规范和本地 prompt 模板。

### 第三期：结构化智能分析

- 将 CodeDelta / CodeGraph 作为**可选的独立本地服务**接入，而不是打进主进程。
- 在“比较两个提交”中展示调用图、受影响符号、影响半径和证据链。
- 向 Codex / ZCode MCP 提供只读的 Git status、staged diff 摘要和结构影响查询；写操作必须经应用 UI 确认，Agent 无权直接 commit/push。

## 8. 开源参考与许可

- [GitHub Desktop](https://github.com/desktop/desktop)：Electron + React + TypeScript 的 Git GUI 交互参考，MIT；重点参考 Changes、Commit、History 与 Branch 的信息层级，不复制 GitHub 商标资源。
- [Lazygit](https://github.com/jesseduffield/lazygit)：文件/区块暂存、提交图、rebase、stash、撤销等功能优先级参考；项目为 Go TUI，不嵌入到 RainTool。
- [SourceGit](https://github.com/sourcegit-scm/sourcegit)：传统 Git GUI 的功能边界与跨平台交互参考，MIT；重点参考仓库页、提交图、Diff、Blame 与远端操作的分层。
- [GitButler](https://github.com/gitbutlerapp/gitbutler)：AI commit、分支堆栈与 agent 工作流的产品参考；其 Fair Source 许可不用于 RainTool 代码复用。
- [CodeDelta](https://github.com/ingeniousfrog/CodeDelta)：后续 commit 结构影响、问题追溯与图谱增强参考；不替代普通 Git Diff，也不作为第一期依赖。
- [simple-git](https://github.com/steveukx/git-js)：Node.js 调用系统 Git 的 MIT 封装参考；第一版保留本项目的窄 `GitRunner`，不把自由命令接口暴露给 IPC。
- [Monaco Editor](https://github.com/microsoft/monaco-editor)：Diff 预览组件来源；使用官方 npm 包，不复制编辑器实现。

实施时只借鉴功能与交互；复制任何第三方代码前必须逐个核对许可证、添加 notice，并保留版权声明。

## 9. ZCode 执行与审核方式

采用**阶段完成后审核**，不要“一次性做完”，也不要每改一个文件就中断。

### 9.1 执行规则

1. ZCode 只能连续完成一个 Task（Task 0–5）及其测试，不能跨 Task 提前实现后续功能。
2. 每个 Task 结束时，ZCode 必须停下并提供：变更文件列表、设计取舍、测试命令及结果、已知限制、待审核点。
3. 审核通过后，才允许开始下一个 Task；发现问题则只在当前 Task 内修正并重新测试。
4. 每个 Task 单独提交一个语义明确的 Git commit；禁止把未审核的多个阶段压成一个大提交。
5. 任何涉及 `commit`、`push`、密钥持久化、删除工作区文件、执行用户仓库命令的实现，都必须通过审核后才能进入下一阶段。

### 9.2 审核关卡

| 关卡 | ZCode 完成内容 | 必审重点 | 放行标准 |
|---|---|---|---|
| Gate 0 | Task 0：分支、依赖和约束确认 | 未触碰 AI Draw.io、MCP、tabs；无无关文件 | 基线测试全绿 |
| Gate 1 | Task 1：GitRunner、状态解析、IPC | 无 shell 拼接；cwd/path 受控；porcelain v2 的 `-z` 解析正确；错误脱敏 | fixture 测试与安全审查通过 |
| Gate 2 | Task 2：变更列表、暂存与 Diff | staged/unstaged 不混淆；二进制/超限/中文路径可靠；无 UI 卡顿 | 手工 fixture 回归通过 |
| Gate 3 | Task 3：commit、fetch/pull/push | 无 force push；pull 固定 `--ff-only`；身份、hook、冲突、认证错误清晰 | bare remote 回归通过 |
| Gate 4 | Task 4：AI 提交说明 | 仅 staged 输入；敏感内容红线；密钥绝不经 IPC 返回；模型不能提交 | redaction 与失败路径测试通过 |
| Gate 5 | Task 5：文档、打包、真实仓库回归 | 许可证、升级文档、完整 build/package、无回归 | 审核、安装包验证均通过 |

### 9.3 给 ZCode 的启动指令

```text
阅读 docs/git-workbench-plan.md 并只执行 Task 0。
严格遵守第 9 节的阶段审核规则：不要开始 Task 1，不要修改 AI Draw.io、MCP 或通用 tabs。
完成后停止，报告变更文件、关键设计、安全措施、测试命令和结果、已知限制；等待审核。
```

后续每次审核通过后，将 `Task 0` 替换为下一项任务编号。若某个审核结论要求修复，ZCode 只能修复该 Task，不得顺手实现后续功能。
