import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { blobHash } from '../patches/gem-hover-patch.mjs';
import { transformGemHoverPatch } from '../patches/gem-hover-patch.mjs';
import { transformItemComparisonPatch } from '../patches/item-comparison-patch.mjs';
import { transformUniqueSortPatch } from '../patches/unique-sort-patch.mjs';
import { transformJewelSpecPatch } from '../patches/jewel-spec-patch.mjs';
import { transformImportTabHostPatch } from '../patches/importtab-host-patch.mjs';
import { transformPreferredExportSitePatch } from '../patches/preferred-export-site-patch.mjs';
import { transformNodePowerPatch } from '../patches/node-power-patch.mjs';
import { transformStatusTextPatch } from '../patches/status-text-patch.mjs';
import { sha256, validateSourceLedger } from './source-ledger.mjs';
import { classifyPatch, parseDriftPatch } from './drift-patch.mjs';

export const PUBLIC_REPOSITORY = 'AdamZ-8113/pob-codes-build-editor';
export const PACK_STAGES = [
  ['limitedUniqueItemComparisons', transformItemComparisonPatch],
  ['gemDropdownHover', transformGemHoverPatch],
  ['uniqueSortDelegation', transformUniqueSortPatch],
  ['calculationOnlyJewelSpecs', transformJewelSpecPatch],
  ['importTabHostCapabilities', transformImportTabHostPatch],
  ['preferredExportSite', transformPreferredExportSitePatch],
  ['nodePowerDelegation', transformNodePowerPatch],
  ['compactStatusText', transformStatusTextPatch],
];
const classes = ['untouched', 'touched-applies', 'conflict', 'absorbed', 'partial'];
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hashes = (files, paths) => Object.fromEntries(paths.filter(path => typeof files[path] === 'string').map(path => [path, blobHash(files[path])]));

export function analyzeDrift({ pin, patches, baseFiles, targetFiles, prStates = {}, identities = false }) {
  const locked = new Set([...pin.compositePatch.files, ...pin.overlays.flatMap(entry => entry.files),
    ...Object.values(pin.adapters).flatMap(adapter => Object.keys(adapter.preparedSourceBlobHashes ?? adapter.sourceBlobHashes ?? adapter.resultBlobHashes))]);
  const changed = new Set([...locked].filter(path => baseFiles[path] !== targetFiles[path]));
  const entries = [];
  const identityOutput = { compositePatch: null, adapters: {} };
  const entry = (id, paths, outcome, prState = null) => ({ id, classification: outcome.classification,
    touchedPaths: paths.filter(path => changed.has(path)).sort(), prState });
  const compositeSections = parseDriftPatch(patches[pin.compositePatch.patchFile]);
  const composite = classifyPatch({ rawFiles: targetFiles, sections: compositeSections, touchedPaths: [...changed].filter(path => pin.compositePatch.files.includes(path)) });
  entries.push(entry('composite', pin.compositePatch.files, composite));
  // PRs were composed with a semantic resolution. Diagnose their retained trees
  // independently; only the recorded composite can prepare the pack input.
  for (const overlay of pin.overlays.filter(item => item.kind === 'upstream-pr')) {
    const outcome = classifyPatch({ rawFiles: targetFiles, sections: parseDriftPatch(patches[overlay.patchFile]), touchedPaths: overlay.files.filter(path => changed.has(path)) });
    entries.push(entry(`pr-${overlay.number}`, overlay.files, outcome, prStates[`pob:${overlay.number}`] ?? 'unknown'));
  }
  const prepared = composite.output;
  if (prepared) identityOutput.compositePatch = { resultBlobHashes: hashes(prepared, pin.compositePatch.files) };
  let current = prepared ? { ...prepared } : { ...targetFiles };
  const blockedPaths = new Set(prepared ? [] : pin.compositePatch.files);
  for (const [name, transform] of PACK_STAGES) {
    const adapter = pin.adapters[name];
    const sections = parseDriftPatch(patches[adapter.patchFile]);
    const paths = Object.keys(adapter.sourceBlobHashes);
    const outcome = classifyPatch({ rawFiles: targetFiles, inputFiles: current,
      sections, touchedPaths: sections.map(section => section.path).filter(path => changed.has(path)),
      blocked: paths.some(path => blockedPaths.has(path)),
      transform: files => {
        const output = { ...files };
        for (const path of paths) output[path] = transform(files[path], patches[adapter.patchFile], path);
        return output;
      } });
    const overlay = pin.overlays.find(item => item.patchFile === adapter.patchFile);
    entries.push(entry(name, sections.map(section => section.path), outcome,
      overlay?.upstreamPr ? prStates[`pob:${overlay.upstreamPr.number}`] ?? 'unknown' : null));
    if (outcome.output) {
      if (identities && prepared && !paths.some(path => blockedPaths.has(path))) {
        identityOutput.adapters[name] = {
          ...(adapter.preparedSourceBlobHashes ? { preparedSourceBlobHashes: hashes(prepared, paths) } : {}),
          sourceBlobHashes: hashes(current, paths), resultBlobHashes: hashes(outcome.output, paths),
        };
      }
      current = outcome.output;
    } else paths.forEach(path => blockedPaths.add(path));
  }
  for (const [name, adapter] of Object.entries(pin.adapters).filter(([, adapter]) => !adapter.patchFile)) {
    const paths = Object.keys(adapter.resultBlobHashes);
    entries.push(entry(name, paths, { classification: paths.some(path => changed.has(path)) ? 'touched-applies' : 'untouched' }));
    if (identities && prepared) identityOutput.adapters[name] = { resultBlobHashes: hashes(prepared, paths) };
  }
  const counts = Object.fromEntries(classes.map(value => [value, entries.filter(item => item.classification === value).length]));
  return { entries, counts, ...(identities ? { identities: identityOutput } : {}) };
}

export function driftExitCode(report, failOn = 'conflict') {
  if (!['conflict', 'touched', 'never'].includes(failOn)) throw new Error('invalid-fail-on');
  if (report.completion !== 'complete') return 2;
  if (failOn === 'never') return 0;
  if (report.counts.conflict || report.counts.partial) return 1;
  return failOn === 'touched' && (report.counts['touched-applies'] || report.counts.absorbed) ? 1 : 0;
}

function git(cwd, args) {
  const result = spawnSync('git', ['-c', `safe.directory=${cwd}`, '-c', 'core.autocrlf=false', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('git-collection-failed');
  }
  return result.stdout;
}

async function prState(repository, number, fetchImpl) {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/pulls/${number}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'build-editor-drift' }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return 'unknown';
    const text = await response.text();
    if (Buffer.byteLength(text) > 256 * 1024) return 'unknown';
    const data = JSON.parse(text);
    return data.merged_at ? 'merged' : data.state === 'open' ? 'open' : data.state === 'closed' ? 'closed' : 'unknown';
  } catch { return 'unknown'; }
}

export async function collectDrift({ root = appDir, ref = 'dev', identities = false, fetchImpl = fetch,
  env = process.env, repositoryOverride } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(ref) || ref.includes('..')) throw new Error('invalid-ref');
  const report = { schemaVersion: 1, repository: PUBLIC_REPOSITORY,
    editorSha: git(root, ['rev-parse', 'HEAD']).trim(),
    workflowRunId: /^\d+$/.test(env.GITHUB_RUN_ID ?? '') ? Number(env.GITHUB_RUN_ID) : null,
    workflowRunAttempt: /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ? Number(env.GITHUB_RUN_ATTEMPT) : null,
    capturedAt: new Date().toISOString(), targetRef: ref, targetSha: null, pinSha: null,
    completion: 'incomplete', errorCode: null, entries: [], counts: Object.fromEntries(classes.map(value => [value, 0])),
    informationalPrs: [], collection: null };
  let directory;
  const started = performance.now();
  try {
    const { pin } = await validateSourceLedger(root);
    report.pinSha = pin.revision;
    directory = await mkdtemp(join(tmpdir(), 'build-editor-drift-'));
    git(directory, ['init', '--quiet']);
    git(directory, ['remote', 'add', 'origin', repositoryOverride ?? pin.repository]);
    git(directory, ['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', pin.revision]);
    git(directory, ['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', ref]);
    report.targetSha = git(directory, ['rev-parse', 'FETCH_HEAD']).trim();
    // Compare trees, not commit reachability: a shallow fetch needs no history.
    const changedPaths = git(directory, ['diff', '--name-only', pin.revision, report.targetSha]).trim().split('\n').filter(Boolean);
    const paths = [...new Set([...pin.compositePatch.files, ...pin.overlays.flatMap(item => item.files),
      ...Object.values(pin.adapters).flatMap(adapter => Object.keys(adapter.preparedSourceBlobHashes ?? adapter.sourceBlobHashes ?? adapter.resultBlobHashes))])];
    const baseFiles = {}, targetFiles = {}, patches = {};
    const basePaths = new Set(git(directory, ['ls-tree', '-r', '--name-only', pin.revision, '--', ...paths]).trim().split('\n'));
    const targetPaths = new Set(git(directory, ['ls-tree', '-r', '--name-only', report.targetSha, '--', ...paths]).trim().split('\n'));
    for (const path of paths) {
      baseFiles[path] = basePaths.has(path) ? git(directory, ['show', `${pin.revision}:${path}`]) : null;
      targetFiles[path] = targetPaths.has(path) ? git(directory, ['show', `${report.targetSha}:${path}`]) : null;
    }
    for (const file of new Set([pin.compositePatch.patchFile, ...pin.overlays.map(item => item.patchFile), ...Object.values(pin.adapters).map(adapter => adapter.patchFile).filter(Boolean)])) {
      patches[file] = await readFile(join(root, file));
    }
    for (const adapter of Object.values(pin.adapters).filter(adapter => adapter.patchFile)) {
      if (sha256(patches[adapter.patchFile]) !== adapter.patchSha256) throw new Error('adapter-patch-identity');
    }
    const prRequests = [...pin.overlays.filter(item => item.kind === 'upstream-pr').map(item => ['pob', 'PathOfBuildingCommunity/PathOfBuilding', item.number]),
      ['pob', 'PathOfBuildingCommunity/PathOfBuilding', 9863],
      ...Array.from({ length: 7 }, (_, i) => ['pob-web', 'atty303/pob-web', 220 + i])];
    const states = await Promise.all(prRequests.map(async ([kind, repository, number]) => [ `${kind}:${number}`, await prState(repository, number, fetchImpl) ]));
    Object.assign(report, analyzeDrift({ pin, patches, baseFiles, targetFiles, identities, prStates: Object.fromEntries(states) }));
    report.informationalPrs = states.map(([id, state]) => ({ id, state }));
    let fetchedBytes = 0;
    for (const file of await readdir(join(directory, '.git', 'objects', 'pack'), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.pack')) fetchedBytes += (await stat(join(directory, '.git', 'objects', 'pack', file.name))).size;
    }
    report.collection = { fetchedBytes, durationMs: Math.round(performance.now() - started), changedPathCount: changedPaths.length };
    report.completion = 'complete';
  } catch {
    report.errorCode = 'collection-failed';
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return report;
}

export function driftMarkdown(report) {
  const lines = ['# Upstream overlay drift', '', `Captured: ${report.capturedAt}`, '',
    `Pin: \`${report.pinSha ?? 'unavailable'}\` · Target: \`${report.targetSha ?? 'unavailable'}\``, '',
    `Collection: **${report.completion}**${report.errorCode ? ` (${report.errorCode})` : ''}`, '',
    '| Entry | Classification | Changed locked paths | PR state |', '| --- | --- | --- | --- |'];
  for (const item of report.entries) lines.push(`| ${item.id} | ${item.classification} | ${item.touchedPaths.join(', ') || '—'} | ${item.prState ?? '—'} |`);
  if (report.informationalPrs.length) lines.push('', 'Informational PR state: ' + report.informationalPrs.map(item => `${item.id}=${item.state}`).join(', ') + '.');
  if (report.identities) lines.push('', 'Candidate identities (print only; pack remains authoritative):', '', '```json', JSON.stringify(report.identities, null, 2), '```');
  return lines.join('\n') + '\n';
}

export async function main(args = process.argv.slice(2), { collect = collectDrift, env = process.env, print = value => console.log(value) } = {}) {
  let ref = 'dev', identities = false, json = false, output, failOn = 'conflict';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--identities') identities = true;
    else if (arg === '--json') json = true;
    else if (arg === '--ref' || arg === '--output') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('invalid-argument');
      if (arg === '--ref') ref = value; else output = value;
    } else if (arg.startsWith('--fail-on=')) failOn = arg.slice(10);
    else throw new Error('invalid-argument');
  }
  if (!['conflict', 'touched', 'never'].includes(failOn)) throw new Error('invalid-fail-on');
  const report = await collect({ ref, identities });
  let encoded = JSON.stringify(report, null, 2) + '\n';
  if (Buffer.byteLength(encoded) > 256 * 1024) {
    report.completion = 'incomplete'; report.errorCode = 'report-bounds';
    report.entries = []; report.counts = Object.fromEntries(classes.map(value => [value, 0]));
    report.informationalPrs = []; delete report.identities;
    encoded = JSON.stringify(report, null, 2) + '\n';
  }
  // Persist evidence before classification can fail the workflow.
  if (output) await writeFile(output, encoded);
  const markdown = driftMarkdown(report);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, markdown);
  print(json ? encoded.trimEnd() : markdown.trimEnd());
  process.exitCode = driftExitCode(report, failOn);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Upstream drift: invalid invocation or report output failure.'); process.exitCode = 2; });
}
