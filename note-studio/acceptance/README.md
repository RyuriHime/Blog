# 验收包

给「这一版能不能收」用的：**一条命令**跑出全部证据，并生成一份可以直接在浏览器里看的报告。

```bash
cd note-studio
node acceptance/run.mjs
# 然后打开 acceptance/output/acceptance-report.html
```

---

## 0. 先玩一下（可操作样例）

不想先读文档、想直接上手：打开 **[`public/playground.html`](../public/playground.html)**（双击即可）。

| 你能做的 | 说明 |
| --- | --- |
| 改内容 | 源码 / 分栏 / 可视化三种模式随便切，公式实时渲染 |
| 载入样例照片并转写 | 点「载入样例照片」→「开始转写」→「插入到光标处」 |
| 换自己的图片 | 「选本地图片」，任何 PNG/JPG 都行 |
| 看文件数据 | 右侧「文件数据」页签是与导出 `.json` 同源的实时统计 |
| 导出 | 「导出 .md」「导出 .json」「导出两个」下载的是**真实文件** |

两种打开方式的行为不同，页面顶部徽标会显示当前形态：

- **双击（file://）→ 离线模式**：编辑、渲染、导出全部可用；图片转写是**明确标注的模拟应答**（演示「转写 → 插入 → 导出」链路，不代表识别质量）。
- **用本地服务打开 → 服务端模式**：`http://127.0.0.1:3011/notes/playground.html`，图片转写走**真实的既有 AI 接口**（同源）；没配 `AI_API_KEY` 时接口返回 503，页面会诚实说明并回落到模拟应答。

> 操作台是生成产物（内嵌了样例照片的 data URL，所以离线也能用）。
> 样例换了之后重跑：`node acceptance/tools/make-playground.mjs`

---

## 报告里有什么

| 区块 | 内容 |
| --- | --- |
| 结论横幅 | 通过 / 跳过 / 失败 的数量，一眼看结论 |
| 一、验收标准与证据 | AC-1…AC-15b，每条标准配「验证方式」+「实际证据」，可展开看逐项明细 |
| 二、样例审查：输入 | 固定的样例图片 + 样例笔记正文（都是纯文本，可审阅） |
| 三、样例审查：渲染结果 | **用编辑器自己的渲染管线在你机器上现算的**（不是截图），能直接看到公式、表格、任务清单 |
| 四、样例审查：图片转写结果 | 转写出的 Markdown 与 LaTeX，附模型与 token 用量 |
| 五、样例审查：交付物 | 真实保存出来的 `sample-note.md` 与 `sample-note.json` 全文 |
| 六、怎么自己复现 | 一条条可粘贴的命令 |
| 七、请你人工确认 | 需要你拍板的 6 件事（含「样例 json 字段是否需要增删」） |

## 三种验收姿势

**1. 只看报告**（最快）

打开 `acceptance/output/acceptance-report.html`。报告是**自包含的判断**：每条标准都写了验证方式与实际数值，你不用信我的话，可以照着第六节的命令自己核。

**2. 自己跑一遍**（推荐）

```bash
node acceptance/run.mjs
```

它会重新落盘样例、重跑 81 项零依赖测试、跑两种论坛布局的集成检查（各 24 项），并重写报告。

**3. 用你真实的视觉模型验收图片转写**（最有说服力）

```bash
set AI_API_KEY=sk-xxx
set AI_MODEL=<支持图片的模型>      # deepseek-chat 是纯文本模型，不能用于转写
node acceptance/run.mjs --live
```

`--live` 会把样例照片真的发给模型，报告第四节显示的就是**真实识别结果**（离线模式那一节是固定应答，只验报文与解析）。

---

## 产物清单（acceptance/output/）

| 文件 | 说明 |
| --- | --- |
| `acceptance-report.html` | 人看的验收报告 |
| `acceptance-report.json` | 同一份结果的机器可读版本（便于对比/入库） |
| `sample-note.md` | 真实保存出来的交付物之一 |
| `sample-note.json` | 真实保存出来的交付物之二（记录基础数据） |
| `convert-result.json` | 图片转写结果（离线假 AI 或 --live 的真实输出） |

## 换成你自己的样例

- 笔记：替换 `acceptance/sample/sample-note.md`（报告会读取它并重算全部统计）
- 图片：替换 `acceptance/sample/sample-note-photo.png`
  - 想重新生成示例图：`python acceptance/tools/make-sample-image.py`（需要 Pillow，仅生成图片用，不是运行时依赖）

## 验收标准一览

| 编号 | 标准 |
| --- | --- |
| AC-1 | 编辑器完全离线自足：不引用任何外网资源，渲染库全部内置 |
| AC-2 | Markdown 渲染正确（标题/表格/任务/代码块） |
| AC-3 | LaTeX 渲染成 `.katex` 结构，页面不残留 `$` 源码 |
| AC-4 | 可视化模式往返：公式 TeX 原样还原（反斜杠不被转义） |
| AC-5 | 保存为一个 `.md` 文件和一个 `.json` 文件，内容与提交一致 |
| AC-6 | `.json` 记录基础数据，且与正文一致（sha256 重算比对） |
| AC-7 | 图片 → Markdown/LaTeX（离线契约级）：报文形状、`json:false`、结果解析 |
| AC-8 | 图片 → Markdown/LaTeX（真实视觉模型，需要 `--live`） |
| AC-9 | 复用既有 AI 接口、不自建：不发 HTTP、不碰密钥、错误码透传 |
| AC-10 | 未配置 AI 时优雅降级（503），编辑与导出不受影响 |
| AC-11 | 独立可搬运：一条命令起服务，包内无 npm 依赖 |
| AC-12 | 接回论坛是最小改动：1 个胶水文件 + 3 处补丁 |
| AC-13 | 安全：文件名路径穿越被切断；未登录读写被拒；静态穿越被拒 |
| AC-14 | 零依赖测试全部通过 |
| AC-15 / 15b | 接回两种布局的论坛后功能可用（AI 版 / 根目录版） |
| AC-16 | 可操作样例：能点、能改、能转写、能导出（不只是只读报告） |
| AC-17 | 正式编辑器：手动编辑、图片转写归入编辑工具栏、实时预览可关可开 |

## 连带的自检

```bash
NODE_PATH=<装有 jsdom 的 node_modules> node tests/browser/verify-report.mjs       # 校验报告本身渲染正常
NODE_PATH=<装有 jsdom 的 node_modules> node tests/browser/verify-playground.mjs   # 操作台能点（37 项）
NODE_PATH=<装有 jsdom 的 node_modules> node tests/browser/verify-editor.mjs       # 正式编辑器能点（21 项）
```

它会像浏览器一样加载报告，确认第三节的「渲染结果」真的渲染出公式（而不是卡在「渲染中…」）。
