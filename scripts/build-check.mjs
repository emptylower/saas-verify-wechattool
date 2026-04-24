import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

await import(path.resolve('src/server.js'));
await import(path.resolve('src/lib/service.js'));
await access(path.resolve('openapi/openapi.yaml'));

execFileSync(process.execPath, ['scripts/check.mjs'], { stdio: 'inherit' });

console.log('Build succeeded.');
