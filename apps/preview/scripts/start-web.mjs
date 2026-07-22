import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const nvmDirectory = process.env.NVM_DIR || join(homedir(), '.nvm');
const versionsDirectory = join(nvmDirectory, 'versions', 'node');
const node20 = existsSync(versionsDirectory)
  ? readdirSync(versionsDirectory).filter(version => version.startsWith('v20.')).sort().at(-1)
  : undefined;
const runtime = node20 && join(versionsDirectory, node20, 'bin', 'node');

if (!runtime || !existsSync(runtime)) {
  console.error('Faultline preview requires Node 20. Install it with: nvm install 20');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const expoCli = require.resolve('expo/bin/cli');
const child = spawn(runtime, [expoCli, 'start', '--web', ...process.argv.slice(2)], { stdio:'inherit' });
child.on('exit', code => process.exit(code ?? 1));
