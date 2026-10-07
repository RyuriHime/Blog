# oi-wiki-src — 上游 OI Wiki 源码（供导入器读）

这个目录**不是**本站自己写的代码，而是 [OI-wiki/OI-wiki](https://github.com/OI-wiki/OI-wiki)
的一份**原样拷贝**，放在仓库里只有一个用途：让 `scripts/seed-oiwiki.mjs` 能离线把 OI Wiki
导成站内的一个 wiki 站（默认名「OI Wiki」），不再依赖仓库外面那份 `../oi-wiki-src`。

```
oi-wiki-src/
└── OI-wiki-master/
    ├── docs/          # 2916 个文件 / 50.9 MB：465 篇 .md + 680 张图 + 代码片段（.cpp/.in/.tex）
    ├── mkdocs.yml     # 目录树（nav:）就来自这里
    ├── README.md      # 上游自己的说明（许可条款写在这份里）
    └── CITATION.bib
```

## 导入器读了什么

| 读的东西 | 用途 |
|---|---|
| `docs/**.md` | 正文（465 篇，`nav:` 收录的 463 篇发布，其余靠 `--extras`） |
| `mkdocs.yml` 里的 `nav:` | 站内三层目录树 + 56 个目录页 + 站首页 14 个入口 |
| 正文里的图片（`![](images/x.svg)` 等） | 拷进 `data/uploads/oi-wiki/…`，引用改写成 `/uploads/oi-wiki/…` |
| `--8<-- "docs/basic/code/x.cpp:core"` 片段 | 按**本目录**解析，把片段现场展开进正文（因此 `.cpp` / `.in` / `.tex` 也得在） |

跑法见仓库根目录 `README.md` 的「站里那个 519 页的 OI Wiki 是怎么来的」一节：

```bash
node scripts/seed-oiwiki.mjs --dry --limit 8     # 只看转换结果，不落库
DB_FILE=data/forum.db node scripts/seed-oiwiki.mjs   # 真导入（默认写 data/p2-preview.db）
```

## 出处与许可

- 来源：<https://github.com/OI-wiki/OI-wiki>（`master` 分支的 zip 快照，取于 2026-10）
- 许可：按上游 `OI-wiki-master/README.md` 里的声明，**除代码部分外**，内容采用
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.zh) 及附加的
  [The Star And Thank Author License](https://github.com/zTrix/sata-license)。
  本站只做**格式转换**（mkdocs-material → 站内积木：折叠块 / 标签页 / 脚注 / 互链 / 图片路径），
  **不改写正文内容**；导进来的页面里保留了原文与出处链接。若你二次分发这里的正文，请照 CC BY-SA 4.0
  署名并以相同方式共享。
- 代码部分（`docs/**/*.cpp` 等示例代码）遵循上游各自的声明。

## 怎么更新

```powershell
# 1) 重新下 zip 并覆盖（保持目录名 OI-wiki-master 不变）
#    https://codeload.github.com/OI-wiki/OI-wiki/zip/refs/heads/master
# 2) 覆盖本目录（只留 docs/ + mkdocs.yml + README.md + CITATION.bib）
robocopy <解压出来的>\OI-wiki-master\docs .\OI-wiki-master\docs /MIR
# 3) 重新导入
DB_FILE=data/forum.db node scripts/seed-oiwiki.mjs
```

> `.gitattributes` 里给本目录标了 `linguist-vendored`，所以 GitHub 的语言统计不会把上游的
> 一万多行 C++ 示例算成这个项目的代码。
