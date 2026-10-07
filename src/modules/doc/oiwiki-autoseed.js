// 「OI Wiki」自动填充：站里有个同名空站，起完服务后自己把它导满。
//
// ── 为什么要有这个文件（而不是在服务器上跑一条命令） ──
// 这 519 页是**数据库内容**，而部署只替换 `src/ public/ scripts/` 三个目录
// （`docs/skeleton.md` §5：deploy.sh 只换这三个目录，新增的顶层目录不会被部署），
// 仓库根、`oi-wiki-src/` 都上不了服务器。也就是说「推 main」搬到线上去的只有代码本身。
// 让**代码自己**把内容导进库里，是纯 GitHub 这一层唯一能把内容弄上去的路子。
//
// 内容从哪来：`scripts/seed-oiwiki.mjs` 找不到本地源码时会去 GitHub 取仓库快照
// （见 `scripts/fetch-oiwiki.mjs`）—— 服务器本来每 3 分钟就要连 GitHub 拉一次 main，
// 这条路是通的。
//
// ── 触发条件（三条全中才跑） ──
//   1) 站名叫「OI Wiki」（默认名字，可用 --station 改，这里按标题找）；
//   2) 站里 0 页（导出成功就是 519 页，所以只可能跑一次）；
//   3) 没有 `OIWIKI_AUTOIMPORT=0`（不想自动导就设它）。
// 导入是拿子进程跑的，主进程只等它的退出码，**不挡 listen**：
// 万一服务器上取不到源码，最多是日志里一句失败，站点照常服务。
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 默认站名，与 scripts/seed-oiwiki.mjs 的 STATION_TITLE 一致。 */
const STATION_TITLE = 'OI Wiki';

/** 导入成功后写的标记：有它就不再自动填了（哪怕站长后来把页删光了 —— 那是他的意思）。 */
function doneMarker(dbFile) {
  return join(dirname(dbFile), 'oi-wiki-imported.flag');
}

/** 找出「该填的那个空站」：同名、0 页、还没填过。 */
export function findStationToFill(queries, { dbFile } = {}) {
  if (dbFile && existsSync(doneMarker(dbFile))) return null;
  let rows = [];
  try {
    rows = queries.stations() ?? [];
  } catch {
    return null; // 老库里还没有 doc_settings 之类的表，就当没有
  }
  return (
    rows.find((row) => String(row.title ?? '').trim() === STATION_TITLE && Number(row.pages ?? 0) === 0) ?? null
  );
}

/**
 * 起完之后调一次：该导就起个子进程去导，立刻返回。
 * @param {{ ctx: object, queries: object }} options
 */
export function autoImportOiwiki({ ctx, queries, log = console.log } = {}) {
  const dbFile = ctx?.options?.dbFile;
  const root = ctx?.options?.root;
  if (!dbFile || !root) return;
  if (process.env.OIWIKI_AUTOIMPORT === '0') {
    log('  → OI Wiki  : 自动导入已关闭（OIWIKI_AUTOIMPORT=0）');
    return;
  }
  const station = findStationToFill(queries, { dbFile });
  if (!station) return;
  const script = join(root, 'scripts', 'seed-oiwiki.mjs');
  if (!existsSync(script)) {
    log(`  → OI Wiki  : 找不到导入脚本 ${script}，跳过`);
    return;
  }
  const username = station.username ?? 'admin';
  log(`  → OI Wiki  : 站 #${station.id}「${station.title}」是空的，后台开始导入（作者 ${username}，首次要下一份源码，几分钟）`);
  const child = spawn(process.execPath, [script, '--station', String(station.title), '--user', String(username)], {
    cwd: root,
    env: { ...process.env, DB_FILE: dbFile },
    stdio: 'inherit',
  });
  child.on('error', (error) => log(`  → OI Wiki  : 起不了导入脚本：${error.message}`));
  child.on('exit', (code) => {
    if (code === 0) {
      try {
        writeFileSync(doneMarker(dbFile), `${new Date().toISOString()}\n站 #${station.id}\n`);
      } catch (error) {
        log(`  → OI Wiki  : 写标记失败（不影响内容）：${error.message}`);
      }
      log('  → OI Wiki  : 导入完成，刷新 #/wiki/OI%20Wiki 就能看到 519 页');
    } else {
      log(`  → OI Wiki  : 导入脚本退出码 ${code}，详见上面的输出（下次启动会再试）`);
    }
  });
}
