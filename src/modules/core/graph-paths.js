// 搬运自 src/server.js 的固定行区间（预铺骨架，逐字未改），见 docs/tools/extract-server-modules.mjs。
import { join } from 'node:path';
import { ROOT } from '../../core/paths.js';

const GRAPH_FILE = join(ROOT, 'data', 'knowledge', 'graph.json');
const GRAPH_STATUS_FILE = join(ROOT, 'data', 'knowledge', 'status.json');
export { GRAPH_FILE, GRAPH_STATUS_FILE };
