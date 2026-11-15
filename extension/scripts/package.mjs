// Builds extension/dist/helpdesk-extension-<version>.zip for upload to the Chrome Web Store.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
mkdirSync(path.join(dir, 'dist'), { recursive: true });
const out = path.join(dir, 'dist', `helpdesk-extension-${version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', out, 'manifest.json', 'managed_schema.json', 'icons', 'src'], { cwd: dir, stdio: 'inherit' });
console.log(`\nCreated ${out}`);
