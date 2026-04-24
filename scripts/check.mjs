import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
      continue;
    }

    if (absolutePath.endsWith('.js') || absolutePath.endsWith('.mjs')) {
      files.push(absolutePath);
    }
  }

  return files;
}

const roots = ['src', 'test', 'scripts'];
const files = [];

for (const root of roots) {
  files.push(...(await collectFiles(root)));
}

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

console.log(`Syntax check passed for ${files.length} files.`);
