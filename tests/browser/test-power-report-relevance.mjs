import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { browserChannel } from '../../scripts/lib/browser-channel.mjs';

// Compare the bundled browser calculator against its unpruned reference.
// Helper parity is covered separately by profile-helper-coverage.mjs.
const directory = await mkdtemp(join(tmpdir(), 'pob-relevance-browser-'));
try {
  for (const [name, metric, fixture] of [
    ['scalar', 'Hit DPS', 'guided import parity desktop 329.txt'],
    ['defensive', 'Effective Hit Pool', 'guided import parity desktop 329.txt'],
    ['minion-full-dps', 'Full DPS', 'dominating blow of inspiring guardian 328.txt'],
  ]) {
    const output = join(directory, `${name}.json`);
    const result = spawnSync(process.execPath, ['tools/profiles/profile-heatmap.mjs',
      '--origin=http://127.0.0.1:3010/', `--browser=${browserChannel() ? 'chrome' : 'chromium'}`,
      `--build-file=fixtures/${fixture}`, `--metric=${metric}`, '--depth=5',
      '--rounds=1', '--warm=0', '--direct', '--report=shown', '--expect-delegation=serial',
      '--baseline-query=helpers=0', '--candidate-query=helpers=0',
      '--baseline-transform=tools/profiles/disable-node-relevance.mjs', '--noise-floor=none', `--out=${output}`],
    { stdio: 'inherit', windowsHide: true, timeout: 180000 });
    assert.equal(result.status, 0, `Unpruned/pruned ${name}: ${result.error?.message ?? 'profile failed'}`);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(report.passed && report.snapshotParity, `Complete ${name} report parity`);
    console.log(`Relevance enabled/disabled: ${name} passed`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
