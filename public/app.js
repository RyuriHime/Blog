// 前端薄入口：只负责「装配」，不含业务逻辑。
//
// 原先的 public/app.js 有 4254 行，19 个视图、路由分发、主题、状态全挤在一起，
// 五个人同时改会天天冲突。现在按「谁拥有什么」拆成：
//
//   public/core/    基础设施（状态 / DOM / 格式 / 主题 / 请求 / 事件 / 会话 / 零件 / 路由）
//   public/views/   13 个页面，每页一个文件
//   public/css/     20 个样式分片，由 /style.css 用 @import 按文件名前缀顺序拼合
//
// ⚠️ index.html 里的 <script type="module" src="/app.js"> 必须**唯一且最后**执行：
//   app.js 是唯一有顶层副作用（bootstrap()）的文件，其余模块只被 import ——
//   在 index.html 里逐个列出它们会导致重复求值，而且改文件名就 404。
//   新增一块功能（feed / doc / ai / team / ui）时：新建 public/views/<名字>.js，
//   在下面加一行 import 即可，别把逻辑塞回这里。

import * as Admin from './views/admin.js';
import * as Ai from './views/ai.js';
import * as AiEdit from './views/ai-edit.js';
import * as Api from './core/api.js';
import * as Auth from './views/auth.js';
import * as Avatar from './core/avatar.js';
import * as Checkin from './views/checkin.js';
import * as Compose from './views/compose.js';
import * as Dom from './core/dom.js';
import * as Events from './core/events.js';
import * as Feed from './views/feed.js';
import * as Fmt from './core/format.js';
import * as Message from './views/messages.js';
import * as Notes from './views/notes.js';
import * as Notif from './views/notifications.js';
import * as Post from './views/post.js';
import * as Prefs from './core/preferences.js';
import * as Router from './core/router.js';
import * as Session from './core/session.js';
import * as Settings from './views/settings.js';
import * as Team from './views/team.js';
import * as Theme from './core/theme.js';
import * as User from './views/user.js';
import * as Widgets from './core/widgets.js';

/* 启动 -------------------------------------------------------------------- */
// 整个前端唯一一处「顶层副作用」：装主题、拉站点数据与会话、渲染侧栏、挂 hashchange、
// 然后跑第一次路由。放在入口文件里是为了让「谁启动应用」一眼可见。
import { bootstrap } from './core/session.js';
bootstrap();
