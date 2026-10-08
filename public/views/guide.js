// 积木教程（`#/guide`）：写给**用**积木的人 —— 从「新建一篇」到「写一段会跑的代码」。
//
// 这一页是**文档**，不是功能：它只 read（`/api/docs/meta/block-types` 拉一次块类型清单），
// 不做任何写操作。样例代码是静态展示的，真正会跑的是编辑器里插进去的那一块。
// 地址 `#/guide` 与侧栏「📖 积木教程」是一对；`#/dev` 是开发者功能（注册块类型 + 存脚本模板）。
//
// 写给谁：第一次用的人。所以顺序是「新建 → 编辑 → 保存 → 分享 → 互动」，
// 会跑代码的部分统一放在后半截的「进阶」里，前面不出现 props / 派生层 这类内部词。
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
    // 数字存在服务端：默认「每人一份」，刷新、明天再来都还在，别人点不影响你。
    let count = Number(await Sandbox.state.get()) || 0;
    const paint = () => {
      document.getElementById('count').textContent = count;
      Sandbox.resize();          // 内容高度变了就喊一声，否则底下会被裁掉
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
    // 沙箱里看不到 cookie / localStorage，连「我登录了吗」都得问一次宿主。
    const me = await Sandbox.viewer();
    const who = me.loggedIn ? (me.displayName || me.username) : '朋友';
    document.getElementById('hello').textContent = who + '，你好。';
    Sandbox.resize();
  })();
</script>`;

const SAMPLE_READ_BLOCKS = `<div id="summary">整理中…</div>
<script>
  (async () => {
    // 读正文里其它块，用来「按别的块算点东西」。
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
    // 传 'shared'：全站共用一份（默认是每人一份）。读谁都行，写要登录。
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
  // 初始化写在 Sandbox.onInit 里（onInit(fn) 与 onInit = fn 两种写法都行）：
  // 它可能比这段脚本先到，宿主会自动等你挂上再把值交过来。
  Sandbox.onInit((props, inputs) => {
    document.getElementById('got').textContent =
      Object.keys(inputs || {}).length ? JSON.stringify(inputs) : '（空）';
    if (props.label) document.title = props.label;   // 自己填的字段都在 props 里
    Sandbox.resize();
  });
  // value() 把这一块的结果交回宿主，下游块就能绑到它。
  document.getElementById('word').oninput = (event) => Sandbox.value(event.target.value);
</script>`;

const SAMPLE_RENDER = `<button id="make" type="button">生成一个引用块</button>
<ul id="made"></ul>
<script>
  (async () => {
    // 脚本生成的块先落在「派生层」，不动正文；作者觉得好，可以在编辑器里采纳成真块。
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
  ['Sandbox.viewer()', '正在看的人：登录了没有、叫什么、是不是作者'],
  ['Sandbox.doc()', '这篇的标题、作者、最后更新时间'],
  ['Sandbox.blocks()', '正文里每一块（连字段一起）'],
  ['Sandbox.state.get(scope?)', '读存下来的数据；没存过就是 null（默认每人一份）'],
  ['Sandbox.state.set(value, scope?)', '存一份数据（要登录；传 \'shared\' 就是全站共用一份）'],
  ['Sandbox.render.list(scope?)', '看脚本已经画出来的块'],
  ['Sandbox.render.canWrite(scope?)', '这个块能不能画别的块（作者打开开关、并且你登录了才是 true）'],
  ['Sandbox.render.put(id, type, props, scope?)', '画一个块'],
  ['Sandbox.render.remove(id, scope?)', '删掉画出来的一个块'],
  // 需求 2：个人主页把自己的信息也交给用户（统计数字、标签、置顶、发过的积木贴与动态）。
  // `Sandbox.profile()` 就是 `GET /api/docs/profile/<用户名>/stats` 的那份数据 ——
  // 主页里的「数据统计」块就是这么写的，「发过的文章数」与列表条数永远同源。
  ['Sandbox.profile()', '看谁的主页就取谁的信息：postCount / repostCount / followerCount / followingCount / pinnedCount / tags / posts'],
  ['Sandbox.request(name, payload?)', '上面这些都是它的简写；名字不在允许清单里就失败'],
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
      const props = fields.length ? fields.map((key) => `<code class="doc-code">${esc(key)}</code>`).join(' ') : '（不用填字段）';
      const how = type.rendererKind === 'sandbox' ? '会跑代码' : '填字段就行';
      return `<li><strong>${esc(type.icon ?? '▢')} ${esc(type.label ?? type.name)}</strong>
        <span class="doc-hint">${esc(how)}${type.builtin ? '' : ' · 站里的人自己加的'}</span><br>
        <span class="doc-hint">要填的字段：</span>${props}</li>`;
    })
    .join('');

  ui.app.innerHTML = `
    <div class="card doc-panel">
      <div class="card-head">
        <span class="card-title">📖 积木教程</span>
        <span class="hint">从新建到发布，一页读完</span>
      </div>
      <p class="doc-hint">积木是这个站写东西的地方：<strong>一篇内容由一段一段的「块」拼起来</strong>，
        每块负责一样东西 —— 一段文字、一张图、一个投票、一个小应用。写的时候填空，
        写完了点一次「保存」，就能把链接发给别人看。</p>
      <p class="doc-hint">没写过也没关系：下面从「新建一篇」开始，照着点一遍就会了。
        想让积木会跑代码（做投票器、小工具、记事本）再看后半截的<strong>进阶</strong>部分。</p>
      <div class="doc-actions">
        <a class="btn btn-sm btn-primary" href="#/docs">去积木广场新建一篇</a>
        <a class="btn btn-sm" href="#/wiki">Wiki 首页</a>
      </div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">1. 新建一篇</span></div>
      <ol class="doc-guide-list">
        <li>打开 <a href="#/docs">积木广场</a>，点<strong>「新建一篇」</strong>。</li>
        <li>它会直接建一篇叫「未命名」的积木，并把你送进编辑器 —— 不用先挑模板。</li>
        <li>标题以后随时能改，名字先放着也行。</li>
      </ol>
      <div class="doc-hint">编辑器地址长这样：<code class="doc-code">#/doc/编号/edit</code>。
        这个链接只有你自己（和站务）打得开，分享给别人要发阅读页的地址。</div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">2. 编辑器怎么用</span></div>
      <ol class="doc-guide-list">
        <li><strong>写正文</strong>：正文是一串块。用「插入块」挑一种，填好字段就行；
          每块右上角可以上下移动、复制、删除。</li>
        <li><strong>改标题</strong>：最上面那张卡里的标题框，顺手把<strong>「谁可以看」</strong>也选上（见第 4 节）。</li>
        <li><strong>保存</strong>：点那张卡的<strong>「保存」</strong>按钮，标题、谁可以看、正文<strong>一次全存</strong>，
          不用先存一样再存另一样。只想改一块，也可以用那一块自己的「保存本块」。</li>
        <li><strong>换写法</strong>：编辑区有三个页签，改的都是同一篇。
          <ul class="doc-guide-list">
            <li><strong>积木</strong>：一块一张卡，最直观，推荐。</li>
            <li><strong>Markdown</strong>：整篇当一篇文章写，习惯打字的人快。</li>
            <li><strong>源码</strong>：直接看数据，块多的时候调起来方便。</li>
          </ul>
        </li>
        <li><strong>写坏不怕</strong>：存的时候有问题会告诉你哪里不对，你的输入不会被清掉；
          页面上还有<strong>修订历史</strong>，随时能回到上一版。</li>
      </ol>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">3. 块类型一览</span><span class="hint">现在有 ${types.length} 种</span></div>
      <div class="doc-hint">下面是这个站支持的全部块（会跟着更新）。挑一种插进去，填字段即可。</div>
      <ul class="doc-guide-list">${typeRows || '<li>块类型列表没拉到，刷新一下试试。</li>'}</ul>
      <div class="doc-hint">想要现成的排版，可以在编辑器里用<strong>模板</strong>：教程、投票问卷、数据表、实验记录都有。</div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">4. 谁可以看</span></div>
      <ul class="doc-guide-list">
        <li><strong>公开</strong>：谁都能看，也会出现在广场里。</li>
        <li><strong>仅关注我的人</strong>：关注了你的人能看。</li>
        <li><strong>仅团队</strong>：同一个团队的人能看。</li>
        <li><strong>仅自己</strong>：草稿就选这个，写好了再改。</li>
      </ul>
      <div class="doc-hint">改完记得点「保存」。别人打不开会看到「这篇文档不存在」，
        和删掉是一样的提示 —— 这是故意的，免得泄露「这里有一篇你无权看的东西」。</div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">5. 分享给别人</span></div>
      <ol class="doc-guide-list">
        <li>阅读页地址就是分享链接：<code class="doc-code">#/doc/编号</code>，复制发出去就行。</li>
        <li>正文里写 <code class="doc-code">[[另一篇的标题]]</code>，会变成一条链接，点进去就是那一篇。</li>
        <li>页面上的<strong>导出 / 导入</strong>能把一篇存成文件、再导到别处。</li>
      </ol>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">6. 标签：分类，也方便找同类</span></div>
      <p class="doc-hint">标签就是给积木贴几个词，一篇最多 5 个。它解决两件事：
        <strong>以后自己找得回来</strong>，以及<strong>让同类内容聚在一起</strong>。</p>
      <ol class="doc-guide-list">
        <li>在编辑器最上面那张卡里，<strong>「标签」框</strong>写几个词，用逗号隔开
          （比如 <code class="doc-code">学术笔记, 公式</code>），点「保存」就跟标题正文一起存好了。</li>
        <li>框下面那排<strong>「大家在用」</strong>是现成的标签，点一下就填进框里 —— 想跟大家用同一个词，点它最省事。</li>
        <li>标签会显示在卡片和阅读页上。<strong>点标签</strong>就跳到
          <code class="doc-code">#/docs?tag=标签</code>，那是「所有贴了这个标签的积木」。</li>
      </ol>
      <div class="doc-hint">以前站里有一个单独的「学术笔记」功能，现在并进来了：
        想写笔记，就写一篇积木、打上 <a href="#/docs?tag=%E5%AD%A6%E6%9C%AF%E7%AC%94%E8%AE%B0">#学术笔记</a> 标签 ——
        公式、代码、双链在积木里都有，还能被搜到、被引用。老地址 <code class="doc-code">#/notes</code> 还开着，
        只为看以前写下的笔记，入口不再出现在导航里。</div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">7. 读者能做什么</span></div>
      <ul class="doc-guide-list">
        <li>每篇底下都有<strong>点赞 / 踩 / 收藏 / 转发 / 关注作者</strong>，还有 <strong>AI 解读</strong>（自动讲这篇在说什么、难在哪）。</li>
        <li><strong>投票块是现成的</strong>：读者点一下就投，结果用百分比条显示出来，不看别人的票数只看比例。</li>
        <li>这些都是按人算的：谁点过赞、谁收藏过，页面按登录身份自己算，不会串。</li>
      </ul>
      <div class="doc-hint">从帖子搬过来的老内容也一样：老帖子页面顶上会写「已经搬进积木了」，
        点过去就是这一套互动。</div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">8. 进阶：让积木会跑代码</span></div>
      <p class="doc-hint">前面都是填字段。如果想让积木自己算、自己画（计数器、计算器、小游戏、
        按别的块的结果出结论），就插这两种块：</p>
      <ol class="doc-guide-list">
        <li><code class="doc-code">小应用</code>：一整段 HTML + JS，界面自己画。</li>
        <li><code class="doc-code">脚本</code>：只写 JS，用来「按正文里别的块算出新块」。</li>
      </ol>
      <ol class="doc-guide-list">
        <li>代码里用 <code class="doc-code">window.Sandbox</code> 跟站子说话 —— 这是唯一出口。</li>
        <li>要数据、要存东西，都得<strong>申请能力</strong>：只有下面这张表里的名字能用，别的会被拒绝。</li>
        <li>内容高度变了记得喊一声 <code class="doc-code">Sandbox.resize()</code>，否则下半截会被裁掉。</li>
        <li>申请一般马上就回，万一卡住<strong>超时是 5 秒</strong>：没登录要存数据、作者没开开关要画块，
          都会失败 —— 用 try/catch 接住，把话写在界面上，别让它白屏。</li>
      </ol>
      <div class="doc-hint">能申请的能力：</div>
      <dl class="doc-block-fields">
        ${CAPABILITY_ROWS.map(([name, note]) => `<dt><code class="doc-code">${esc(name)}</code></dt><dd>${esc(note)}</dd>`).join('')}
      </dl>
      <div class="doc-hint">代码是在一个隔离的小框里跑的：读不到浏览器的 cookie、发不出网络请求、
        也引不了外部脚本。要站里的数据，就规规矩矩申请上面那几项。</div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">9. 例子：记个数（会存下来）</span></div>
      <div class="doc-hint">最小的一片能存东西的代码。默认「每人一份」：别人点不会改你的数。</div>
      ${code(SAMPLE_COUNT)}
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">10. 例子：认出正在看的人</span></div>
      ${code(SAMPLE_HELLO)}
      <div class="doc-hint">想按人给不同内容，就用 <code class="doc-code">Sandbox.viewer()</code>。</div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">11. 例子：数一数正文里有什么</span></div>
      ${code(SAMPLE_READ_BLOCKS)}
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">12. 例子：全站共用一个数</span></div>
      ${code(SAMPLE_SHARED)}
      <div class="doc-hint">写共用数据要登录：没登录的读者点了会看到你那句提示，这是正常的。</div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">13. 例子：两块联动</span></div>
      <div class="doc-hint">在块的设置里，把上游块的结果绑到这个块的字段上；下游就在
        <code class="doc-code">Sandbox.inputs</code> 里收到它 —— 不用写死。</div>
      ${code(SAMPLE_BIND)}
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">14. 例子：让脚本画出新块</span></div>
      <div class="doc-hint">「脚本」块可以生成别的块：先放在<strong>派生层</strong>，正文一个字都不动；
        作者看着喜欢，就在编辑器里把它们<strong>采纳</strong>成真块。
        要三件事齐了才行：作者打开「允许脚本改块」、你登录了、这种块类型注册过。</div>
      ${code(SAMPLE_RENDER)}
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">15. 例子：整块小界面</span></div>
      ${code(SAMPLE_APP)}
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">16. 进阶：把写顺手的代码存起来</span></div>
      <ol class="doc-guide-list">
        <li>到 <a href="#/dev">开发者功能</a> 里的「我的脚本模板」，把代码粘进去、起个名字存下。</li>
        <li>以后在卡片上点「用它新建一篇」：它建一篇只带这一块的积木，并把你送进编辑器。
          代码里有 HTML 标签就建成<strong>小应用</strong>块，纯 JS 就建成<strong>脚本</strong>块。</li>
        <li>模板只有自己看得见，数量有上限；「编辑这段」把内容填回表单，改完保存就是覆盖。</li>
      </ol>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">17. 进阶：给全站加一种新块</span><span class="hint">写给会写模板的人</span></div>
      <ol class="doc-guide-list">
        <li><strong>填字段式</strong>：写一份字段说明（每个字段叫什么、什么类型、必不必填）+ 一段渲染模板，
          用 <code class="doc-code">{{字段}}</code> 取值。最省事，渲染走服务端，天然安全。</li>
        <li><strong>跑代码式</strong>：声明成沙箱块，界面由代码自己画 —— 想做什么都行。</li>
        <li>注册完立刻能在编辑器里插入；内置类型不可覆盖。</li>
      </ol>
      <div class="doc-actions"><a class="btn btn-sm" href="#/dev">去开发者功能注册</a></div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">18. 应用示例：从零开始建一个 OI Wiki</span><span class="hint">全程只在站内编辑</span></div>
      <p class="doc-hint">站里已经有现成的例子：<a href="#/wiki/OI%20Wiki">OI Wiki 站</a>
        —— 465 篇正文、56 个目录页，全是用下面这套办法搬进来的，<strong>没有改过一行站点代码</strong>。
        想自己搭一个同样规模的 wiki，照这个顺序做：</p>
      <ol class="doc-guide-list">
        <li><strong>建站</strong>：打开 <a href="#/wiki">Wiki 首页</a>，在「＋ 新建一个 wiki」里写个名字
          （比如「我的算法笔记」）。站本身就是一个普通帖子，谁能看跟别的积木一样设。</li>
        <li><strong>建页</strong>：进站以后点「＋ 新建页面」，建一页就得一篇独立文档，页名之后随时能改。</li>
        <li><strong>把内容粘进来</strong>：进编辑器的 <strong>Markdown</strong> 页签，整篇贴进去点「保存」——
          标题、列表、表格、代码、公式、图片会各自解析成块。手上只有一份现成的 Markdown 时，这条最快。</li>
        <li><strong>长解释收进折叠块</strong>：遇到「一大段可以收起来」的内容，就在积木页签插一个
          <strong>折叠块</strong>：填标题和正文，读者点标题才展开；「默认展开」这个开关决定初始状态。</li>
        <li><strong>图片</strong>：插图块，或者 Markdown 里写
          <code class="doc-code">![说明](/uploads/…)</code>。图存在站里，别人直接能看。</li>
        <li><strong>把页连起来</strong>：正文里写 <code class="doc-code">[[另一页的标题]]</code> 就是一条内链；
          标题写错也不会断，会显示成一条<strong>红链</strong>，点它就能当场新建那一页 —— OI Wiki 里几千条互链就是这么连的。</li>
        <li><strong>排目录</strong>：站的首页用<strong>子页面</strong>块摆卡片（选 <code class="doc-code">card</code>），
          或者选 <code class="doc-code">full</code> 把一整页嵌进来；页与页的父子关系、先后顺序在站页面上调，
          几分钟就能从「一堆页」变成「一棵目录树」。</li>
        <li><strong>代码</strong>：用代码块，语言写 <code class="doc-code">cpp</code> / <code class="doc-code">python</code> 之类就会高亮。
          <code class="doc-code">--8&lt;--</code> 这种「从别的文件里抽一段」的写法本站没有，把片段直接贴进代码块即可。</li>
        <li><strong>脚注</strong>：本站不认 <code class="doc-code">[^1]</code>；写成
          <code class="doc-code">&lt;sup&gt;1&lt;/sup&gt;</code>，文末再来一节「脚注」用有序列表列出来。</li>
      </ol>
      <div class="doc-hint">三条经验：① <strong>每页只讲一件事</strong>，页名就是这件事的名字 —— 目录树、内链、搜索全靠它；
        ② 先粘正文、再收折叠块、最后排目录，别一边排一边补；
        ③ 每页的「源码」页签永远能看，改坏了随时改回来（还有修订历史兜底）。</div>
      <div class="doc-actions">
        <a class="btn btn-sm btn-primary" href="#/wiki">去建一个自己的 wiki</a>
        <a class="btn btn-sm" href="#/wiki/OI%20Wiki">看现成的 OI Wiki 站</a>
      </div>
    </div>

    <div class="card doc-panel doc-guide">
      <div class="card-head"><span class="card-title">19. 个人主页就是一篇积木</span><span class="hint">自己的信息，自己排版</span></div>
      <p class="doc-hint">个人主页的底层和积木帖子是<strong>同一套东西</strong>：一份
        <code class="doc-code">kind='profile'</code> 的文档。主页上的每一段——名片、统计、标签、
        置顶推荐、发过的积木贴、发过的动态——都是<strong>块</strong>，可以自由增删改与移动。
        在主页右上角点「✏️ 翻新我的主页（🧩 把主页变成积木）」就进积木编辑器；
        主页<strong>不会</strong>出现在积木广场里。</p>
      <ol class="doc-guide-list">
        <li><strong>锁着的那一块</strong>：「个人主页名片」块（头像 / 昵称 / 签名 / 关注、私信、拉黑）。
          内容能改，但<strong>不许删、不许挪</strong>——它永远在第一位。别的块随便加、随便删。</li>
        <li><strong>保存前会判定</strong>：不合法的个人主页存不下去。规则就三条：至少留一块、
          块数与标题不超上限、名片块有且只有一个且在第一位。判定的代码前后端同源，浏览器里先算一遍，
          服务端再算一遍（服务端那次是权威）。</li>
        <li><strong>你自己的信息，用户可以自己取</strong>：脚本块里调
          <code class="doc-code">Sandbox.profile()</code> 就拿到主页主人的信息 ——
          <code class="doc-code">postCount</code>（发过的积木贴数）、<code class="doc-code">repostCount</code>（发过的动态数）、
          <code class="doc-code">followerCount</code> / <code class="doc-code">followingCount</code>（关注者 / 关注中）、
          <code class="doc-code">pinnedCount</code>、<code class="doc-code">tags</code>、<code class="doc-code">posts</code>。
          它和 <code class="doc-code">GET /api/docs/profile/&lt;用户名&gt;/stats</code> 返回的是同一份数据。</li>
        <li><strong>数字和列表永远对得上</strong>：主页上「发过的文章数」是按同一套可见性规则数出来的，
          和下面列出来的条数<strong>相等</strong>——一个 wiki 站无论里面多少页，在主页上只算一篇。</li>
        <li><strong>想换回旧排版</strong>：删掉主页文档里的块不影响你发过的帖子；
          「✏️ 翻新」只是一次性把主页变成积木，随时在编辑器里改回来。</li>
      </ol>
      <div class="doc-hint">例子：统计块里写
        <code class="doc-code">const me = await Sandbox.profile(); document.getElementById('n').textContent = me.postCount;</code>
        —— 这就是种子块「数据统计」的做法，复制一份改成你想要的排版就行。</div>
      <div class="doc-actions">
        <a class="btn btn-sm btn-primary" href="#/docs">去积木广场</a>
        <a class="btn btn-sm" href="#/dev">块类型表</a>
      </div>
    </div>

    <div class="card doc-panel">
      <div class="card-head"><span class="card-title">看完就去试</span></div>
      <div class="doc-actions">
        <a class="btn btn-sm btn-primary" href="#/docs">积木广场</a>
        <a class="btn btn-sm" href="#/dev">开发者功能</a>
        <a class="btn btn-sm btn-ghost" href="#/wiki">Wiki 首页</a>
      </div>
      <div class="doc-hint">边看边试最快：新建一篇，插两个块，点一次保存，再回头看看自己写出来的页面。</div>
    </div>`;
}

/* @hand-written */
