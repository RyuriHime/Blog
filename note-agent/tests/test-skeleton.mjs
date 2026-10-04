import { createChecker } from './helpers/check.mjs';
import { BLOCK_TYPES, isBlockId } from '../src/blocks.mjs';

const { check, summary } = createChecker();

check('BLOCK_TYPES 恰好 7 种且顺序固定', BLOCK_TYPES.join(',') === 'heading,paragraph,list,code,table,formula,image');
check('isBlockId 接受 b1 / b42', isBlockId('b1') && isBlockId('b42'));
check('isBlockId 拒绝 B1 / b0x / 空 / 数字', !isBlockId('B1') && !isBlockId('b0x') && !isBlockId('') && !isBlockId(1));

summary();
