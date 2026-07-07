# 截图功能设计文档

> 日期: 2026-07-08
> 状态: 设计已确认,待编写实现计划
> 项目: RainTool (Electron + React + Zustand 桌面工具箱)

## 1. 概述

为 RainTool 新增专业截图功能:系统级全局快捷键触发截图,支持全屏/区域/窗口三种模式;截图后默认直接贴图悬浮于桌面,贴图窗口内可轻量标注;贴图可保存到截图历史,双击历史项进入标签页专业编辑器做深度编辑。快捷键完全可自定义。

### 1.1 核心体验

- 系统级全局快捷键,任何应用下都能触发截图
- 截图后直接贴图悬浮(Snipaste 形态),点击进入标注
- 贴图轻量标注 + 标签页专业编辑器,编辑器只完整实现一次
- 截图历史缩略图墙,命名统一生效
- 多贴图同时悬浮
- 快捷键可自定义,含冲突检测

### 1.2 设计决策汇总

| 维度 | 决策 |
|------|------|
| 快捷键范围 | 系统级全局(globalShortcut),多个可自定义 |
| 截图模式 | 全屏 + 区域 + 窗口 |
| 编辑深度 | 贴图轻量标注 / 标签页专业编辑(C 档) |
| 默认流向 | 截图→直接贴图,点击进入编辑 |
| 贴图编辑交互 | 贴图窗口内编辑,所见即所得 |
| 持久化策略 | 贴图不恢复;保存到历史才持久;历史缩略图墙 |
| tab 数据模型 | 统一 Tab 结构,scenario + 文件索引,图片不进 JSON |
| 保存格式 | 图层 JSON + 预览 PNG 双存,无损可继续编辑 |
| 画布库 | fabric.js |
| 架构统一 | 一次性统一,现有文本工具一并迁移到 file-backed 模型 |

## 2. 整体架构

三层结构,三个独立单元各自单一职责:

### 2.1 三个单元

**单元 1 — 截图引擎(主进程)**
globalShortcut 触发,desktopCapturer 截图,nativeImage 处理,写 PNG 到磁盘,按需创建贴图窗口。

**单元 2 — 贴图窗口(独立 BrowserWindow)**
无边框置顶,内嵌 fabric 轻量标注,可多开,临时不持久。独立 HTML 入口(`pin.html`),不经主窗口 React 路由。

**单元 3 — 历史 + 编辑器(主窗口标签页)**
缩略图墙 + 专业编辑器,复用现有 tab 体系,JSON+PNG 双存。

### 2.2 关键数据流

```
① 全局快捷键 → 主进程截图引擎 → 生成 PNG 写磁盘
② 主进程创建贴图窗口 → 窗口加载该 PNG → 用户轻量标注
③ 贴图"保存到历史" → 写入 tabs store(open=true)→ 缩略图墙刷新
④ 双击历史项 → 创建编辑器标签页(scenario='screenshot')→ fabric 加载 JSON+PNG
⑤ 编辑器保存 → 覆盖写 JSON + PNG → 历史缩略图刷新
```

图片始终在磁盘,store 只存路径。

## 3. 统一数据模型

整个 RainTool 统一为一套 Tab 结构:scenario + 文件索引,渲染按 scenario 分流。这是一次性迁移,现有文本工具一并改为 file-backed。

### 3.1 统一 Tab 结构

```ts
interface Tab {
  id: string
  scenario: string          // 工具标识:'json-format' | 'screenshot' | ...
  name: string              // 统一命名,各处生效
  createdAt: number

  // 统一文件索引 — 所有内容落盘,不进 JSON
  files: {
    primary: string         // 必有 — 主内容(文本=.txt, 截图=.png)
    source?: string         // 可选 — 可编辑图层源(fabric JSON)
    thumb?: string          // 可选 — 缩略图(历史墙)
    secondary?: string      // 可选 — diff/对比右侧(json-workbench)
  }

  // 文本工具的内存缓存(从 primary 加载,debounce 写回)
  // 工具组件无感知,仍通过 ToolProps 拿到 input/onInput
  input?: string

  // 视图/标签状态
  open: boolean             // true=标签栏 / false=已关闭(历史)
  groupId?: string
}
```

### 3.2 各 scenario 的 files 填充

| scenario | primary | source | thumb | secondary |
|----------|---------|--------|-------|-----------|
| json-format | `<id>.txt` | — | — | — |
| json-workbench | `<id>.json`(左) | — | — | `<id>.r.json`(右) |
| screenshot | `<id>.png` | `<id>.json`(图层) | `<id>.thumb.png` | — |

### 3.3 "截图历史"是视图,不是独立 store

"截图历史" = `tabs.filter(t => t.scenario === 'screenshot')`,无论 open 与否。标签栏 = `tabs.filter(t => t.open)`。关闭标签页不删除记录,而是 `open=false` 进历史。一切皆有历史。

### 3.4 磁盘布局

```
~/raintool/
├── workspace.json          # tabs 索引(路径+元数据,轻量)
├── settings.json           # 快捷键设置
└── tabs/                   # 所有 tab 内容文件
    └── screenshots/        # 截图场景子目录
        ├── <id>.png        # 完整/合并图
        ├── <id>.thumb.png  # 缩略图(~200px 宽)
        └── <id>.json       # 图层(fabric canvas.toJSON,未编辑过不存在)
```

### 3.5 文本工具的 file-backed 管道

工具组件零改动:`ToolProps` 不变,文本工具仍收 `input`/`onInput`。改动在 store 层:
- `hydrate()`:从 `files.primary` 读取文件内容 → 填充 `input` 缓存
- `setTabInput(v)`:更新 `input` 缓存 + 300ms debounce 写回 `files.primary`
- 组件无感知,只通过 `ToolProps` 与 store 交互

### 3.6 命名统一生效

`name` 字段在 Tab 上,以下位置统一显示:
- 历史缩略图墙 — 缩略图下方
- 标签页标题
- 贴图窗口标题/右键菜单
- 另存为默认文件名

改名时:tabs store 更新 `name` → 自动 persist → 依赖该 record 的标签页标题同步刷新。标签页标题从 store 派生,而非 tab 自己存一份,避免不同步。默认名称:`截图 YYYY-MM-DD HH:mm`(时间戳)。

## 4. 截图引擎

### 4.1 全局快捷键注册

主进程启动时读取 `settings.json`,为每个快捷键调用 `globalShortcut.register`:

```ts
import { globalShortcut, desktopCapturer, screen, nativeImage, BrowserWindow } from 'electron'

const DEFAULT_SHORTCUTS = {
  captureRegion: 'CommandOrControl+Shift+A',
  captureScreen: 'CommandOrControl+Shift+S',
  captureWindow: 'CommandOrControl+Shift+W',
  togglePins:    'CommandOrControl+Shift+P',
}

function registerShortcuts(map: ShortcutSettings) {
  globalShortcut.unregisterAll()
  globalShortcut.register(map.captureRegion, () => startCapture('region'))
  globalShortcut.register(map.captureScreen, () => startCapture('screen'))
  globalShortcut.register(map.captureWindow, () => startCapture('window'))
  globalShortcut.register(map.togglePins,    () => toggleAllPins())
}
```

用户改快捷键时,渲染进程通过 IPC `shortcut:update` 通知主进程,主进程先持久化到 `settings.json`,再 `unregisterAll` + 重新注册。应用退出时 `globalShortcut.unregisterAll()` 清理。

### 4.2 三种截图模式

```ts
async function startCapture(mode: 'region' | 'screen' | 'window') {
  const sources = await desktopCapturer.getSources({
    types: mode === 'window' ? ['window'] : ['screen'],
    thumbnailSize: { width: 9999, height: 9999 }  // 原始分辨率
  })

  if (mode === 'screen') {
    // 每个显示器一张,直接落盘 + 贴图
    for (const s of sources) createPinFromSource(s)
    return
  }

  if (mode === 'window') {
    pickWindowAndPin(sources)  // 枚举窗口,弹选择菜单
    return
  }

  // region: 创建全屏覆盖窗口让用户拖拽框选
  const overlay = createSelectionOverlay(sources)
}
```

### 4.3 区域截图选区窗口

最复杂的一环,流程:

1. 主进程用 `desktopCapturer` 截取所有显示器全屏图
2. 为**每个显示器**创建一个全屏置顶的 `BrowserWindow`(frame:false, transparent:true, alwaysOnTop:true),铺对应显示器全屏图作背景
3. 用户在覆盖窗口上拖拽矩形选区(渲染进程处理鼠标事件)
4. 选区确定后,主进程从全屏图中裁剪对应区域 → `nativeImage.crop()` → 生成 PNG → 关闭覆盖窗口 → 创建贴图窗口
5. Esc 取消,关闭覆盖窗口

```
快捷键触发
  → desktopCapturer 截全屏图(各显示器)
  → 创建选区覆盖窗口(全屏,铺底图,半透明遮罩)
  → 用户拖拽矩形 + Enter 确认 / Esc 取消
  → 主进程从全屏图裁剪选区 → nativeImage.crop()
  → 生成 <id>.png + <id>.thumb.png 落盘
  → 关闭覆盖窗口
  → 创建贴图窗口加载该 PNG
```

### 4.4 落盘与缩略图生成

```ts
async function saveCapture(img: nativeImage, source: CaptureSource): Promise<string> {
  const id = crypto.randomUUID()
  const dir = path.join(getDataDir(), 'tabs', 'screenshots')
  const filePath = path.join(dir, `${id}.png`)
  const thumbPath = path.join(dir, `${id}.thumb.png`)

  fs.writeFileSync(filePath, img.toPNG())

  const thumb = img.resize({ width: 200 })
  fs.writeFileSync(thumbPath, thumb.toPNG())

  // 在 tabs store 创建一条 scenario='screenshot', open=false 的记录
  // name 默认 "截图 YYYY-MM-DD HH:mm"
  return id
}
```

### 4.5 新增 IPC 清单

| Channel | 方向 | 用途 |
|---------|------|------|
| `shortcut:get` / `shortcut:update` | 渲染→主 | 读/改快捷键,改完主进程重新注册 |
| `capture:region-select` | 覆盖窗口→主 | 区域选区完成,传回矩形坐标 |
| `capture:cancel` | 覆盖窗口→主 | Esc 取消截图 |
| `pin:create` | 主→贴图窗口 | 创建贴图窗口,加载指定 PNG |
| `pin:close` | 贴图窗口→主 | 关闭单个贴图 |
| `pin:toggle-all` | 主→所有贴图窗口 | 显示/隐藏所有贴图 |
| `pin:save-to-history` | 贴图窗口→主 | 贴图"保存到历史"(open=true 进标签栏) |
| `screenshot:saveAs` | 渲染→主 | 弹系统对话框另存为 |
| `screenshot:rename` | 渲染→主 | 改名(实际走 store,IPC 仅通知) |

## 5. 贴图窗口

### 5.1 窗口属性

```ts
function createPinWindow(record: Tab, x: number, y: number) {
  // 从图片文件读取尺寸(不存进 Tab 结构,避免冗余)
  const img = nativeImage.createFromPath(record.files.primary)
  const { width, height } = img.getSize()

  const win = new BrowserWindow({
    width, height,             // 从图片实际尺寸获取
    x, y,                      // 截图原位(区域)或屏幕中央(全屏/窗口)
    frame: false,              // 无边框
    transparent: true,         // 透明背景
    alwaysOnTop: true,         // 置顶
    resizable: true,           // 可缩放
    hasShadow: true,           // 投影区分贴图与桌面
    skipTaskbar: true,         // 不进任务栏
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: pinPreload }
  })
  win.loadFile('dist/pin.html')  // 独立入口
}
```

独立 HTML 入口 `pin.html`,不经主窗口 React 路由,加载快、互不干扰。

### 5.2 交互三态

| 状态 | 触发 | 鼠标行为 | 工具栏 |
|------|------|---------|--------|
| 悬浮态(默认) | 创建后 / 点外部 | 拖拽移动;滚轮缩放;右键菜单 | 右上角角标(保存/复制/关闭) |
| 标注态 | 双击贴图 | fabric 绘制 | 顶部浮动工具栏 |
| 编辑态 | "进编辑器"按钮 | 同标注态 + 撤销重做 | 完整轻量工具栏 |

退出标注:点贴图外部或按 Esc → 回悬浮态。

### 5.3 悬浮态右上角角标

鼠标移入显示,移出隐藏:
- 💾 保存(保存到历史,open=true 进标签栏)
- 📋 复制到剪贴板
- ✕ 关闭贴图

### 5.4 标注态工具栏

顶部浮动工具栏,自动避让贴图边缘:

**9 种绘图工具**:
1. ▭ 长方形(默认)
2. ◯ 椭圆/圆形
3. → 箭头
4. ∕ 直线
5. ✎ 画笔(自由绘制)
6. T 文字
7. ▦ 马赛克
8. ▮ 高亮笔(半透明)
9. ① 序号标注(自动递增)

**辅助按钮**:
- ⌫ 撤销
- 📋 复制
- 💾 保存(绿色高亮,直接可见)

### 5.5 颜色与线宽

**颜色**:预设调色板 8 色,默认红色
- 红 `#ef4444`、橙 `#f59e0b`、绿 `#10b981`、蓝 `#3b82f6`、紫 `#8b5cf6`、白 `#ffffff`、黑 `#000000`、黄 `#fbbf24`

**线宽/字号**:3 档(细/中/粗),默认中

### 5.6 缩放

悬浮态滚轮缩放,以鼠标位置为锚点。范围 10%~800%。缩放只改窗口尺寸,不改图片分辨率(图片始终是原始 PNG,fabric 画布按 CSS transform 缩放)。

### 5.7 右键菜单(精简,低频操作)

- 另存为…
- 进入编辑器(新标签页)
- ────────
- 关闭贴图

### 5.8 贴图与历史的连接

贴图是**临时**的(关掉就没了,重启不恢复)。但贴图内的标注可"保存到历史":
- 贴图保存按钮 / 角标 → "保存到历史"
- 主进程将贴图当前 fabric 画布序列化为 `<id>.json`(图层),合并图为 `<id>.png`(覆盖原始截图)
- 同时重新生成 `<id>.thumb.png` 缩略图
- tabs store 将该记录(贴图窗口持有的 tab id)`open` 改为 `true` → 进标签栏
- 贴图窗口可关闭,内容已在标签页编辑器里

**重要**:贴图窗口创建时即持有截图时生成的 tab id(此时 `open=false`,历史可见)。保存到历史不是新建记录,而是更新同一条:写图层 JSON + 覆盖合并图 + 重新生成缩略图 + `open` 改 `true`。

## 6. 历史墙 + 专业编辑器

### 6.1 历史缩略图墙(截图工具标签页默认视图)

打开"截图"工具标签页时,默认显示历史墙:

- **网格布局**,每张显示缩略图 + 名称 + 来源/尺寸
- **顶部操作栏**:新截图按钮 + 总数 + 搜索框 + 排序(最新优先)
- **交互**:
  - 单击 = 放大预览
  - 双击 = 进入编辑器(新标签页,scenario='screenshot')
  - 右键 = 重命名 / 另存为 / 删除
- 缩略图按 `files.thumb` 异步加载 `<img>`,滚动不卡

### 6.2 专业编辑器(双击历史项后,新标签页打开)

C 档完整专业编辑,布局:

**左侧工具栏**(垂直):
- 9 种绘图工具(与贴图共享同一套 fabric 图形能力)
- ⤢ 裁剪
- ↻ 旋转

**顶部操作栏**:
- ↶ 撤销 / ↷ 重做(完整撤销栈)
- 颜色调色板(8 色)
- 线宽选择(3 档)
- 📋 复制 / 另存为 / 💾 保存(绿色高亮)

**画布区**:fabric 画布,所见即所得

**右侧面板**:
- **图层列表**:每个 fabric 对象一个图层,可显隐(👁)/选中/删除/拖拽排序
- **滤镜**:无 / 灰度 / 模糊 / 反色(应用到底图层)

### 6.3 编辑器与贴图的差异

编辑器比贴图窗口多了:
- 图层管理面板(显隐/选中/删除/排序)
- 滤镜(灰度/模糊/反色)
- 裁剪 / 旋转
- 完整撤销重做栈

两者共享同一套 9 种 fabric 图形工具。

### 6.4 保存

编辑器保存 = 覆盖写:
- `<id>.json` — fabric `canvas.toJSON()`,含底图路径 + 所有图层/标注,无损可继续编辑
- `<id>.png` — 合并后的预览图(`canvas.toDataURL()` → 写盘),覆盖原 primary
- `<id>.thumb.png` — 重新生成缩略图(从新合并图 resize 到 200px 宽),覆盖原 thumb

历史缩略图墙自动刷新(从 `files.thumb` 重新加载)。三层文件同步更新,确保历史墙显示的是最新编辑结果。

### 6.5 另存为

主进程 IPC `screenshot:saveAs`,用 `dialog.showSaveDialog`:
```ts
ipcMain.handle('screenshot:saveAs', async (_e, { sourcePath, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,           // 用 tab.name
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  })
  if (canceled || !filePath) return null
  await fs.copyFile(sourcePath, filePath)
  return filePath
})
```

触发点:历史缩略图右键 / 编辑器工具栏 / 贴图右键菜单。另存为是导出副本,不影响内部原件。

## 7. 快捷键设置面板

### 7.1 集成位置

集成到现有 `SettingsFloat`,新增"快捷键"分区,与"版本/更新"分区并列。

### 7.2 4 个全局快捷键

| 功能 | 默认快捷键 | 说明 |
|------|-----------|------|
| 区域截图 | `⌘⇧A` | 拖拽框选屏幕区域 |
| 全屏截图 | `⌘⇧S` | 截取整个屏幕 |
| 窗口截图 | `⌘⇧W` | 截取指定应用窗口 |
| 显示/隐藏所有贴图 | `⌘⇧P` | 一键切换所有贴图可见性 |

### 7.3 录入流程

1. 点 ✎ 进入录入态,显示"按下组合键..."
2. 用户按下组合键,实时显示(如 `⌘⇧4`)
3. 检查冲突:与系统占用 / RainTool 其他键是否重复
4. 无冲突 → 保存到 settings store → IPC 通知主进程重新注册
5. 有冲突 → 红色提示,不保存,等待重按
6. 可随时"恢复默认"

### 7.4 settings store

新建 zustand store,持久化到 `~/raintool/settings.json`:

```ts
interface ShortcutSettings {
  shortcuts: {
    captureRegion: string   // 'CommandOrControl+Shift+A'
    captureScreen: string   // 'CommandOrControl+Shift+S'
    captureWindow: string   // 'CommandOrControl+Shift+W'
    togglePins: string      // 'CommandOrControl+Shift+P'
  }
}
```

主进程启动时读这个 store 注册 globalShortcut。

## 8. 文件清单(新增/修改)

### 8.1 新增文件

| 文件 | 用途 |
|------|------|
| `electron/pin-window.ts` | 贴图窗口创建/管理 |
| `electron/capture-overlay.ts` | 区域截图选区覆盖窗口 |
| `electron/pin-preload.ts` | 贴图窗口 preload |
| `pin.html` + `pin/main.tsx` | 贴图窗口独立入口 |
| `src/components/tools/screenshot/index.tsx` | 截图工具标签页(历史墙) |
| `src/components/tools/screenshot/Editor.tsx` | 专业编辑器 |
| `src/components/tools/screenshot/Gallery.tsx` | 历史缩略图墙 |
| `src/components/tools/screenshot/Toolbar.tsx` | 共享 fabric 工具栏 |
| `src/components/tools/screenshot/useFabric.ts` | fabric canvas hook |
| `src/store/settings.ts` | 快捷键设置 store |
| `src/types/screenshot.d.ts` | 截图相关类型 |

### 8.2 修改文件

| 文件 | 改动 |
|------|------|
| `electron/main.ts` | 新增 globalShortcut、截图 IPC、贴图窗口管理 |
| `electron/preload.ts` | 暴露 capture/pin/shortcut API |
| `src/types/raintool.d.ts` | 补充新 API 类型 |
| `src/components/tools/catalog.ts` | 注册 screenshot 工具 + 新 'media' 分类 |
| `src/components/tools/shared.tsx` | ToolProps 保持不变(零改动) |
| `src/components/layout/Workspace.tsx` | 按 scenario 路由渲染(文本工具 vs 截图编辑器) |
| `src/store/tabs.ts` | 迁移到统一 Tab 模型(scenario + files + open) |
| `src/components/settings/SettingsFloat.tsx` | 新增快捷键设置分区 |
| `src/App.tsx` | 启动时注册全局快捷键(通过 IPC) |
| `package.json` | 新增 fabric 依赖 |
| `vite.config.ts` | 多入口构建(main + pin) |
| `electron-builder.yml`(若有) | 打包包含 pin.html |

## 9. 依赖

### 9.1 新增

- `fabric` — 画布对象化、图层、序列化往返(`canvas.toJSON()` / `loadFromJSON()`)

### 9.2 不引入

- 无 konva(fabric 序列化能力更匹配需求)
- 无 screenshot-desktop(Electron desktopCapturer 已足够)
- 无 sharp/jimp(nativeImage.resize 足够生成缩略图)

## 10. 错误处理与边界

- **快捷键注册失败**:系统占用时 `globalShortcut.register` 返回 false,设置面板显示冲突提示
- **截图权限**:macOS 首次截图需屏幕录制权限,主进程检测权限缺失时弹引导
- **磁盘空间**:写文件前不预检,写入失败 catch 并提示用户
- **多显示器**:区域截图为每个显示器建覆盖窗口,坐标用 `screen` 模块换算
- **贴图窗口过多**:无硬性上限,依赖 OS 窗口管理;togglePins 可一键隐藏全部
- **fabric 加载失败**:`loadFromJSON` 失败时回退到仅加载底图 PNG,不阻断编辑器
- **文件丢失**:tab 引用的文件不存在时,标签页显示"文件丢失"占位,不崩溃

## 11. 测试要点

- 全局快捷键在 RainTool 非聚焦时触发
- 三种截图模式各自正确截取
- 区域截图多显示器场景
- 贴图多开 + togglePins 显隐
- 贴图标注保存到历史后,历史墙刷新
- 编辑器图层往返:保存 → 重开 → 图层完整恢复
- 快捷键冲突检测 + 恢复默认
- 统一 Tab 模型:文本工具迁移后 hydrate/persist 正常
- 关闭标签页进历史,重新打开恢复内容
