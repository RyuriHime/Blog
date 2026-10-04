import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const git = 'C:\\Users\\Ryuri\\AppData\\Local\\Programs\\PortableGit\\cmd\\git.exe';
const repo = 'D:\\Project1\\Blog';
const out = process.argv[2];
const spec = process.argv[3]; // e.g. '9a3e4f4:src/db.js'

const buffer = execFileSync(git, ['-C', repo, 'show', spec], { maxBuffer: 64 * 1024 * 1024 });
writeFileSync(out, buffer);
console.log(`写入 ${out}（${buffer.length} 字节）`);
