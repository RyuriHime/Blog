/**
 * 上传限额与白名单。
 *
 * 单独一个文件是因为这些常量会被 service 层、HTTP 层、前端面板和测试同时引用；
 * 放在这里可以避免 multipart 解析器被前端/测试以"只想要常量"的理由拉进来。
 */

/** 单文件 4MB、单会话 12MB、单会话最多 10 个源文件。 */
export const UPLOAD_RULES = {
  maxFileBytes: 4 * 1024 * 1024,
  maxSessionBytes: 12 * 1024 * 1024,
  maxFiles: 10,
  extensions: ['.md', '.markdown', '.txt', '.docx', '.pptx', '.pdf'],
};
