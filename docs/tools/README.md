# docs/tools —— 骨架改造用过的一次性工具

**这些不是测试，日常不用跑，也别顺手改。** 它们只在「当初把大文件拆成小文件」时用过一次，
留在这里是为了让那次搬家**可复现、可审计**（万一有人质疑「你是不是手工抄错了一行」）。

跑之前先看清楚：**这几个脚本都不幂等，而且会直接覆盖 `src/` 与 `public/` 下的成品文件。**

| 脚本 | 干什么 | 重跑的前提 |
| --- | --- | --- |
| `scan-app-decls.mjs` | 扫描器的**真相来源**：用逐字符状态机（掩码注释/字符串/模板字符串/正则）找出 `public/app.js` 里所有顶层块的起止行 | 只读，随便跑。它会打印每个块的标签与行号 |
| `extract-app-modules.mjs` | 把 `public/app.js` 拆成 `public/core/*` + `public/views/*` + 44 行入口 | 先把原始 4254 行的 `app.js` 还原回去（见下） |
| `extract-server-modules.mjs` | 把 `src/server.js` 拆成 `src/core/*` + `src/modules/core/*` + 薄入口 | 先 `git checkout <改造前的提交> -- src/db.js src/server.js` |
| `split-css.mjs` | 把 `public/style.css` 拆成 `public/css/*`（按章节注释切，保留原级联顺序） | 先还原原始 `style.css` |
| `check-public-modules.mjs` | **这个可以随时跑**：造假 DOM，逐个 `import()` 每个 `public/*.js`，一次报出全部 import/语法错误 | 只读 |
| `check-core-boot.mjs` | **这个可以随时跑**：用一个临时库跑 `openDatabase()`，验证 17 张表能独立建全并完成播种 | 只读 |

## 跑搬运脚本的正确顺序

```bash
# 1) 还原输入（脚本不幂等，第二次跑会把已经拆好的薄入口当输入，报「顶层块只有 1 个」）
cp .tmp-app/app.js.orig public/app.js
cp .tmp-app/style.css.orig public/style.css
git checkout <改造前的提交> -- src/db.js src/server.js

# 2) 再跑
node docs/tools/extract-app-modules.mjs
node docs/tools/split-css.mjs
node docs/tools/extract-server-modules.mjs

# 3) 跑完必须验证（这三个脚本自带覆盖自检，会打印「每一行都有归宿」）
node docs/tools/check-public-modules.mjs
node docs/tools/check-core-boot.mjs
node docs/tools/check-frontend.mjs      # 在 scripts/ 下，18 个页面全渲染
node scripts/check-golden.mjs           # 行为金标准，96 项
```

## 两个已经踩过的坑（写在这里免得下一个人再踩）

1. **`@hand-written` 标记会让生成器永远跳过这个文件。** 目标文件首行带这个标记时，
   搬运脚本认为「这是人手写的，不能覆盖」。想让它重新生成，必须先把那行标记改掉。
2. **不要用 PowerShell 的 `Get-Content -Raw` + 文本替换去改 `.js`/`.mjs`。**
   PowerShell 默认按系统代码页解码，会把 UTF-8 中文读成乱码再写回去，**不可逆**。
   要批量改就用 Node 脚本，或者用编辑工具一个一个改。
