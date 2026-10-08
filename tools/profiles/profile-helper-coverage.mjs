import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

// Public-fixture functional coverage, not a machine-independent speed gate.
// Every case compares complete serial/parallel report snapshots and demands
// successful delegation. Keep expensive profiles opt-in, outside ordinary CI.
const args = process.argv.slice(2);
const option = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const base = 'guided import parity desktop 329.txt';
const minion = 'dominating blow of inspiring guardian 328.txt';
const cases = [
  {name:'offence-defence', metric:'Offence/Defence', depth:5, fixture:'lightning strike daughter of oshabi 328 alternate.txt'},
  {name:'custom-depth', metric:'Life', depth:7, fixture:base},
  {name:'defensive', metric:'Effective Hit Pool', depth:5, fixture:base},
  {name:'transformed', metric:'Taken Phys dmg', depth:5, fixture:base},
  {name:'minion-full-dps', metric:'Full DPS', depth:5, fixture:minion},
  {name:'minion-defensive', metric:'Minion Effective Hit Pool', depth:5, fixture:minion},
  {name:'depth-15', metric:'Hit DPS', depth:15, fixture:base},
  {name:'depth-all', metric:'Hit DPS', depth:'All', fixture:base},
  ...['glorious vanity','brutal restraint','militant faith','heroic tragedy']
    .map(family => ({name:family.replaceAll(' ','-'), metric:'Hit DPS', depth:5, fixture:`timeless ${family} 329.json`})),
  ...['baleful dominion','destructive aspiration','extinguishing grasp','festering vengeance','reclaimed malevolence']
    .map(family => ({name:family.replaceAll(' ','-'), metric:'Hit DPS', depth:5, fixture:`abyss timeless ${family} 329.json`})),
];
const selected = option('case')?.split(',');
if (selected) assert.ok(selected.length && selected.every(name => cases.some(item => item.name === name)), 'Unknown coverage case');
const output = resolve(option('out', 'tmp/helper-coverage/public'));
await mkdir(output, {recursive:true});
const summary = [];
for (const item of cases.filter(item => !selected || selected.includes(item.name))) {
  const file = join(output, item.name + '.json');
  console.log('Coverage:', item.name);
  await new Promise((accept, reject) => {
    const command = ['tools/profiles/profile-heatmap.mjs', `--origin=${option('origin','http://127.0.0.1:3011/import2/')}`,
      `--browser=${option('browser','chromium')}`, `--build-file=fixtures/${item.fixture}`, `--metric=${item.metric}`, `--depth=${item.depth}`,
      '--rounds=1', '--warm=0', '--direct', '--report=shown', '--baseline-query=helpers=0',
      '--candidate-query=helpers=3&nodePowerHelpers=1', '--noise-floor=none', `--out=${file}`];
    if (option('firefox-executable')) command.push(`--firefox-executable=${option('firefox-executable')}`);
    const child = spawn(process.execPath, command, {stdio:'inherit', windowsHide:true, detached:process.platform !== 'win32'});
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio:'ignore', windowsHide:true});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(error); } }
    }, 600000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); code === 0 && !timedOut ? accept() : reject(new Error(`${item.name} ${timedOut ? 'exceeded its ten-minute process deadline' : 'failed'}`)); });
  });
  const result = JSON.parse(await readFile(file,'utf8'));
  assert.ok(result.passed && result.snapshotParity);
  summary.push({case:item.name, browser:result.environment.browser, parity:true,
    runs:result.runs.map(run => ({arm:run.arm, ms:run.reportWallMs, delegation:run.delegation,
      bytes:run.helpers?.bytes, recycled:run.helpers?.recycled}))});
  await writeFile(join(output,'summary.json'), JSON.stringify(summary,null,2)+'\n');
}
console.log('Coverage passed:', summary.length);
