// 积木教程（`#/guide`）：一页读完「积木是什么、怎么用、怎么写自己的块」。
//
// 这一页是**文档**，不是功能：它只 read（`/api/docs/meta/block-types` 拉一次块类型清单），
// 不做任何写操作。样例代码是静态展示的，真正会跑的是编辑器里插进去的那一块。
// 地址 `#/guide` 与侧栏「📖 积木教程」是一对；`#/dev` 是开发者功能（注册块类型 + 存脚本模板）。
import { esc, loadingHtml, ui } from '../core/dom.js';
import { api } from '../core/api.js';
import { toastError } from '../core/errors.js';

/* ------------------------------------------------------------------ */
/* 样例代码                                                            */
/* ------------------------------------------------------------------ */

/** 代码样例的排版：等宽、可横向滚动。 */
const code = (source) => `<pre class="guide-pre">${esc(source)}</pre>`;

const SAMPLE_COUNT = `<h3 id="count">0</h3>
<button id="inc" type="button">+1</button>
<button id="reset" type="button">清零</button>
<script>
  (async () => {
    // 状态存在服务端：按「这一块 + 这个人」各存一份，刷新、明天再来都还在。
    let count = Number(await Sandbox.state.get()) || 0;
    const paint = () => {
      document.getElementById('count').textContent = count;
      Sandbox.resize();          // 高度变了就要喊一声，否则宿主按旧高度裁掉下半截
    };
    document.getElementById('inc').onclick = async () => {
      count += 1;
      await Sandbox.state.set(count);
      paint();
    };
    document.getElementById('reset').onclick = async () => {
      count = 0;
      await Sandbox.state.set(count);
      paint();
    };
    paint();
  })();
</script>`;

const SAMPLE_HELLO = `<p id="hello">…</p>
<script>
  (async () => {
    // 沙箱里看不到 cookie / localStorage，连「我登录了吗」都得申请一次。
    const me = await Sandbox.viewer();
    const who = me.loggedIn ? (me.displayName || me.username) : '朋友';
    document.getElementById('hello').textContent = who + '，你好。';
    Sandbox.resize();
  })();
</script>`;

const SAMPLE_READ_BLOCKS = `<div id="summary">整理中…</div>
<script>
  (async () => {
    // 读正文里其它块的 { id, type, props } —— 「按别的块算点东西」靠它。
    const blocks = await Sandbox.blocks();
    const polls = blocks.filter((block) => block.type === 'poll');
    const heading = blocks.filter((block) => block.type === 'heading');
    document.getElementById('summary').textContent =
      '这篇里有 ' + heading.length + ' 个小标题、' + polls.length + ' 个投票。';
    Sandbox.resize();
  })();
</script>`;

const SAMPLE_SHARED = `<button id="vote" type="button">我也要一票</button>
<span id="n">…</span>
<script>
  (async () => {
    // scope = 'shared'：全站共用一份（默认 'user' 是每人一份）。
    // 读不用登录；写要登录，所以这里必须能接受失败。
    const paint = async () => {
      const value = (await Sandbox.state.get('shared')) || 0;
      document.getElementById('n').textContent = '已有 ' + value + ' 票';
      Sandbox.resize();
    };
    document.getElementById('vote').onclick = async () => {
      try {
        const now = (await Sandbox.state.get('shared')) || 0;
        await Sandbox.state.set(now + 1, 'shared');
        await paint();
      } catch (error) {
        document.getElementById('n').textContent = '要登录才能加票';
      }
    };
    paint();
  })();
</script>`;

const SAMPLE_BIND = `<input id="word" type="text" placeholder="打点字，喂给下游的块">
<p id="from">上游给的：<b id="got">（空）</b></p>
<script>
  // props 是这一块自己的字段；inputs 是上游块绑过来喂进来的值。
  // 两种写法都行：Sandbox.onInit(fn) 与 Sandbox.onInit = fn —— 而且 init
  // 有可能比这段脚本先到，bootstrap 会自动等你挂上再交付。
  Sandbox.onInit((props, inputs) => {
    document.getElementById('got').textContent =
      Object.keys(inputs || {}).length ? JSON.stringify(inputs) : '（空）';
    if (props.label) document.title = props.label;   // 字段都在 props 里
    Sandbox.resize();
  });
  // value() 把这一块的结果交回宿主，下游块就能绑到它。
  document.getElementById('word').oninput = (event) => Sandbox.value(event.target.value);
</script>`;

const SAMPLE_RENDER = `<button id="make" type="button">生成一个引用块</button>
<ul id="made"></ul>
<script>
  (async () => {
    // render 写的是**派生层**（不是正文）：作者觉得好，可以在编辑器里「采纳为真块」。
    const canWrite = await Sandbox.render.canWrite();
    document.getElementById('make').disabled = !canWrite;
    if (!canWrite) document.getElementById('made').textContent = '作者没打开「允许脚本改块」';
    const paint = async () => {
      const blocks = await Sandbox.render.list();
      document.getElementById('made').innerHTML =
        blocks.map((block) => '<li>' + block.type + ' · ' + block.id + '</li>').join('');
      Sandbox.resize();
    };
    document.getElementById('make').onclick = async () => {
      // put(id, type, props, scope)：id 只能是字母数字下划线短横线，最长 32
      await Sandbox.render.put('made-quote', 'quote', { text: '这段话是脚本写的', source: '沙箱' });
      await paint();
    };
    paint();
  })();
</script>`;

const SAMPLE_APP = `<h3>今日进度</h3>
<progress id="bar" max="100" value="0"></progress>
<span id="pct">0%</span>
<script>
  (async () => {
    const inputs = Sandbox.inputs || {};
    const value = Number(inputs.done ?? 0);
    document.getElementById('bar').value = value;
    document.getElementById('pct').textContent = value + '%';
    Sandbox.resize();
  })();
</script>`;

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

const CAPABILITY_ROWS = [
  ['Sandbox.viewer()', '正在看的人：{ loggedIn, id, username, displayName, staff, author }'],
  ['Sandbox.doc()', '这篇文档的公开元信息：{ id, title, kind, author, updatedAt }'],
  ['Sandbox.blocks()', '正文里每一块：{ id, type, props }[]'],
  ['Sandbox.state.get(scope?)', '读持久状态，返回存的 JSON 值或 null（scope 省略 = 每人一份）'],
  ['Sandbox.state.set(value, scope?)', '写持久状态（要登录；scope 传 \'shared\' 就是全站一份）'],
  ['Sandbox.render.list(scope?)', '读派生层：脚本画出来的块（永远允许，只回你本来就看得见的）'],
  ['Sandbox.render.canWrite(scope?)', '派生层能不能写（作者打开「允许脚本改块」之后才是 true）'],
  ['Sandbox.render.put(id, type, props, scope?)', '往派生层写一块（要登录 + 开关打开 + 类型已注册）'],
  ['Sandbox.render.remove(id, scope?)', '删掉派生层里的一块'],
  ['Sandbox.request(name, payload?)', '上面这些都是它的便捷写法；名字不在白名单就 reject'],
];

export async function viewGuide() {
  ui.app.innerHTML = `<div class="card doc-panel">${loadingHtml('教程加载中…')}</div>`;
  let types = [];
  try {
    const data = await api('/api/docs/meta/block-types');
    types = data.types ?? [];
  } catch (error) {
    toastError(error);
  }

  const typeRows = types
    .map((type) => {
      const fields = Object.keys(type.schema ?? {});
      const props = fields.length ? fields.map((key) => `<code class="doc-code">${esc(key)}</code>`).join(' ') : '（没有字段）';
      const how = type.rendererKind === 'sandbox' ? '沙箱里跑代码' : type.builtin ? '内置渲染' : '自定义模板';
      return `<li><strong>${esc(type.icon ?? '▢')} ${esc(type.label ?? type.name)}</strong>
        <code class="doc-code">${esc(type.name)}</code>
        <span class="doc-hint">${esc(how)}${type.builtin ? '' : ' · 自定义'}</span><br>
        <span class="doc-hint">字段：</span>${props}</li>`;
    })
    .join('');

  ui.app.innerHTML = `
    <div class="card doc-panel">
      <div class="card-head">
        <span class="card-title">📖 积木教程</span>
        <span class="hint">一页读完</span>
      </div>
      <p class="doc-hint">积木（块）是这个站的可编程帖子格式：一篇文档就是一串块，每块有自己的字段；
        需要跑代码的块在<strong>沙箱 iframe</strong> 里跑，只拿得到你在代码里明确申请的东西。
        看不懂下面任何一段，都可以先去 <a href="#/docs">积木广场</a> 新建一篇点点看。</p>
      <div class="doc-actions">
        <a class="btn btn-sm btn-primary" href="#/docs">去积木广场</a>
        <a class="btn btn-sm" href="#/dev">开发者功能（注册块类型 / 存脚本模板）</a>
      </div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">1. 积木是什么</span></div>
      <ol class="doc-guide-list">
        <li><strong>一篇文档 = 一串块</strong>。块的顺序就是阅读顺序，每块有自己的类型和字段（props）。</li>
        <li><strong>阅读页的正文是服务端渲染好的 HTML</strong>。也就是说：没有 JS、被爬虫抓走、复制粘贴，
           文字都还在 —— 只有需要交互的块（脚本 / 小应用 / 投票）才在浏览器里再动起来。</li>
        <li><strong>块可以互相引用、互相喂值</strong>：「联动」把上游块的结果绑到下游块的字段上，
           沙箱里的代码从 <code class="doc-code">Sandbox.inputs</code> 拿到它。</li>
        <li><strong>脚本不碰本站</strong>。它在一个不透明源的 iframe 里跑，读不到浏览器的 cookie / localStorage，
           也发不出网络请求；想知道什么，就得向宿主<strong>申请能力</strong>，每次申请都记一条审计。</li>
        <li><strong>旧帖子还在</strong>，只是不再是「写东西」的主路：新内容建议直接用积木写，帖子会逐步退成历史档案。</li>
      </ol>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">2. 五分钟上手</span></div>
      <ol class="doc-guide-list">
        <li>进 <a href="#/docs">积木广场</a>，点「新建一篇」—— 它直接建一篇「未命名」并把你送进编辑器（没有模板墙要选）。</li>
        <li>编辑器有<strong>三档</strong>，随时切换、改的都是同一篇：
          <ul class="doc-guide-list">
            <li><strong>🧱 积木模式</strong>：一块一张卡，填表单；插入块、上下移动、删除都在这。</li>
            <li><strong>📝 纯 Markdown</strong>：整篇当一篇 Markdown 写；块以 <code class="doc-code">\`\`\`doc:类型</code> 围栏的形式存下来。</li>
            <li><strong>⚡ 源码模式</strong>：直接改块的 props JSON，进阶入口，坏 JSON 会报错但不清空你的输入。</li>
          </ul>
        </li>
        <li>写完把<strong>标题</strong>和<strong>谁可以看</strong>（私有 / 关注者 / 团队 / 公开）存一下。</li>
        <li>阅读页地址就是分享链接：<code class="doc-code">#/doc/&lt;id&gt;</code>。
            <code class="doc-code">#/doc/&lt;id&gt;/edit</code> 是编辑器，只有作者和管理员打得开。</li>
        <li>正文里写 <code class="doc-code">[[另一篇的标题]]</code> 会变成双链，点进去就是那一篇。</li>
        <li>右上角还有：<strong>导出 / 导入</strong>（JSON，可以把一篇搬到别处）、<strong>修订历史</strong>（可回滚）。</li>
      </ol>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">3. 块类型一览</span><span class="hint">${types.length} 种</span></div>
      <div class="doc-hint">新增一种块类型不用改核心代码：写一份 schema（字段 + 渲染模板），或者用沙箱渲染。
        注册入口在 <a href="#/dev">开发者功能</a>。</div>
      <ul class="doc-guide-list">${typeRows || '<li>块类型列表没拉到，刷新试试。</li>'}</ul>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">4. 写一段会跑的代码</span></div>
      <ol class="doc-guide-list">
        <li>在编辑器里插一个 <code class="doc-code">小应用</code>（app）块：它的代码是一整段 HTML/JS，
           想画什么界面都行。<code class="doc-code">脚本</code>（script）块不一样，它的正文是<strong>裸 JS</strong>，
           用来「画别的块」（派生层）而不是画自己。</li>
        <li>代码里用 <code class="doc-code">window.Sandbox</code> 跟宿主打交道。它是沙箱里唯一的出口。</li>
        <li>拿数据、存状态、画块，都是<strong>申请能力</strong>：宿主只认白名单里的名字，其余的记一条审计并拒绝。</li>
        <li>高度变了就调一次 <code class="doc-code">Sandbox.resize()</code>。忘了它，页面会按旧高度裁掉下半截。</li>
      </ol>
      <div class="doc-hint">能申请的能力（写错的会失败，超时 5 秒）：</div>
      <dl class="doc-block-fields">
        ${CAPABILITY_ROWS.map(([name, note]) => `<dt><code class="doc-code">${esc(name)}</code></dt><dd>${esc(note)}</dd>`).join('')}
      </dl>
      <div class="doc-hint">拿不到的东西，不要绕：读 cookie、发 fetch、引外部脚本全被沙箱挡住。
        要站内数据就申请 <code class="doc-code">viewer</code> / <code class="doc-code">doc-blocks</code>。</div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">5. 例子：计数器（存状态）</span></div>
      <div class="doc-hint">最小的一片能存东西的代码 —— 默认状态是「每人一份」，别人点不会改你的数。</div>
      ${code(SAMPLE_COUNT)}
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">6. 例子：认人</span></div>
      ${code(SAMPLE_HELLO)}
      <div class="doc-hint">想按人给不同的界面，就 <code class="doc-code">Sandbox.viewer()</code>。</div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">7. 例子：读正文里的其它块</span></div>
      ${code(SAMPLE_READ_BLOCKS)}
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">8. 例子：全站共用一份状态</span></div>
      ${code(SAMPLE_SHARED)}
      <div class="doc-hint">写共享状态要登录；读谁都行。这类「公共计数」的玩法请自觉，滥用会被审计日志看见。</div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">9. 例子：跟别的块联动</span></div>
      <div class="doc-hint">在块的设置里把上游块的结果绑到这个块的字段上，下游就会在 <code class="doc-code">Sandbox.inputs</code> 里收到它。</div>
      ${code(SAMPLE_BIND)}
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">10. 例子：脚本画块（派生层）</span></div>
      <div class="doc-hint">「脚本」块可以生成别的块：它们先落在<strong>派生层</strong>，不动正文；
        作者觉得好，在编辑器里把它们<strong>采纳</strong>成真块。三道闸：作者打开「允许脚本改块」+ 你登录了 + 类型注册过。</div>
      ${code(SAMPLE_RENDER)}
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">11. 例子：小应用（一整块界面）</span></div>
      ${code(SAMPLE_APP)}
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">12. 脚本模板：把顺手的代码存起来</span></div>
      <ol class="doc-guide-list">
        <li>到 <a href="#/dev">开发者功能</a> → 「我的脚本模板」，把代码粘进去、起个名字存下。</li>
        <li>之后在卡片上点「用它新建一篇」：它建一篇只带这一块的积木并把你送进编辑器。
          代码里带 HTML 标签就建成<strong>小应用</strong>块，纯 JS 就建成<strong>脚本</strong>块。</li>
        <li>模板只有自己看得见，数量有上限；「编辑这段」会把内容填回表单，改完保存就是覆盖。</li>
      </ol>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">13. 自己发明一种块</span></div>
      <ol class="doc-guide-list">
        <li><strong>声明式</strong>：写一份 props schema + 一段渲染模板 HTML（用 <code class="doc-code">{{字段}}</code> 取值）。
           最省事，渲染仍走服务端管线，天然安全。</li>
        <li><strong>沙箱式</strong>：类型声明成 sandbox，由代码自己画 —— 想做什么都行，但读者那个块会在 iframe 里跑。</li>
        <li>注册完立刻能在编辑器里插入，也能在源码里用 <code class="doc-code">\`\`\`doc:你的类型名</code>。</li>
        <li>内置类型不可覆盖；自定义类型的字段一样会被校验（必填、长度、选项都在 schema 里管）。</li>
      </ol>
      <div class="doc-actions"><a class="btn btn-sm" href="#/dev">去注册一个</a></div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">14. 踩过的坑</span></div>
      <ol class="doc-guide-list">
        <li><strong>不调 resize</strong>：内容被切成半截，看起来像「功能只画了一半」。</li>
        <li><strong>init 比你的脚本先到</strong>：所以初始化代码写在 <code class="doc-code">Sandbox.onInit</code> 里，
           不要写在顶层（宿主已经帮你兜住了这个时序）。</li>
        <li><strong>能力超时 5 秒</strong>：没登录就写状态、开关没开就写派生层，都会 reject —— 用 try/catch 接住，
           把话告诉读者，不要让块白屏。</li>
        <li><strong>沙箱是外来户</strong>：读不到 cookie、发不出请求、引不了外部脚本和图片。</li>
        <li><strong>一篇最多一个脚本块</strong>；单块代码长度也有上限（超了保存会报错）。</li>
        <li><strong>Markdown 模式会重写块</strong>：从块转到 Markdown 再转回来，块的字段按围栏格式往返，
           手改围栏里的 JSON 要小心（改坏了会降级成警告块，不会整篇打不开）。</li>
      </ol>
    </div>

    <div class="card doc-panel">
      <div class="card-head"><span class="card-title">还想看点别的</span></div>
      <div class="doc-actions">
        <a class="btn btn-sm" href="#/docs">积木广场</a>
        <a class="btn btn-sm" href="#/dev">开发者功能</a>
        <a class="btn btn-sm btn-ghost" href="#/wiki">Wiki 首页</a>
      </div>
      <div class="doc-hint">这一页是教程；想动手就去广场新建一篇，边看边试最快。</div>
    </div>`;
}

/* @hand-written */
