import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Whole dedicated Chromium process tree, not Wasm capacity or shared-page RSS.
// A resident PowerShell sampler avoids launching a shell for every 250ms sample.
const sampler = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class PobProcessTree {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint size, usage, pid;
    public UIntPtr heap;
    public uint module, threads, parent;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr handle, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr handle, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int[] Members(int root, long rootBirth) {
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    var parents = new Dictionary<int, int>();
    try {
      var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
      if (!Process32FirstW(snapshot, ref entry)) throw new System.ComponentModel.Win32Exception();
      do { parents[(int)entry.pid] = (int)entry.parent; } while (Process32NextW(snapshot, ref entry));
    } finally { CloseHandle(snapshot); }
    var members = new Dictionary<int, long>(); members[root] = rootBirth;
    bool changed;
    do {
      changed = false;
      foreach (var item in parents) {
        if (!members.ContainsKey(item.Value) || members.ContainsKey(item.Key)) continue;
        try {
          using (var process = Process.GetProcessById(item.Key)) {
            var birth = process.StartTime.ToUniversalTime().Ticks;
            // Windows retains parent IDs after exit. PID reuse must not
            // adopt unrelated older processes into the new browser tree.
            if (birth < members[item.Value]) continue;
            members[item.Key] = birth; changed = true;
          }
        } catch (ArgumentException) { } catch (InvalidOperationException) { }
      }
    } while (changed);
    var result = new int[members.Count]; members.Keys.CopyTo(result, 0); return result;
  }
}
'@
$rootProcessId = ROOT_PROCESS_ID
$rootProcess = [Diagnostics.Process]::GetProcessById($rootProcessId)
$rootBirth = $rootProcess.StartTime.ToUniversalTime().Ticks
$rootProcess.Dispose()
$timer = [Diagnostics.Stopwatch]::StartNew()
$nextSample = 0L
while ($true) {
  $rows = @()
  $rootAlive = $false
  foreach ($memberId in [PobProcessTree]::Members($rootProcessId, $rootBirth)) {
    try {
      $member = [Diagnostics.Process]::GetProcessById($memberId)
      try {
        $member.Refresh()
        $started = $member.StartTime
        if ($null -eq $started -or $member.HasExited) { continue }
        $birth = $started.ToUniversalTime().Ticks
        if ($birth -lt $rootBirth -or ($memberId -eq $rootProcessId -and $birth -ne $rootBirth)) { continue }
        $row = @{ pid = $memberId; name = $member.ProcessName; startedUtc = $started.ToUniversalTime().ToString('o'); privateBytes = $member.PrivateMemorySize64; peakPrivateBytes = $member.PeakPagedMemorySize64 }
        if ($member.HasExited) { continue }
        $rows += $row
        if ($memberId -eq $rootProcessId) { $rootAlive = $true }
      } finally { $member.Dispose() }
    } catch [ArgumentException] { } catch [InvalidOperationException] { } # Child exited during the read.
  }
  if (-not $rootAlive) { throw 'Dedicated browser process exited during memory capture' }
  @{ elapsedMs = $timer.ElapsedMilliseconds; processes = $rows } | ConvertTo-Json -Compress -Depth 4
  $nextSample += 250
  $delay = $nextSample - $timer.ElapsedMilliseconds
  if ($delay -gt 0) { Start-Sleep -Milliseconds $delay } else { $nextSample = $timer.ElapsedMilliseconds }
}
`;

export function summarizeProcessMemory(samples) {
  if (!samples.length) throw new Error('No process-tree memory samples');
  const peaks = new Map();
  let peakBytes = 0, maximumSampleGapMs = 0;
  for (const [index, sample] of samples.entries()) {
    if (!Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0 ||
        (index && sample.elapsedMs < samples[index - 1].elapsedMs) || !sample.processes?.length) throw new Error('Invalid process-tree sample');
    const seen = new Set();
    let total = 0;
    for (const process of sample.processes) {
      if (seen.has(process.pid)) throw new Error('Duplicate process in memory sample');
      seen.add(process.pid);
      if (!Number.isSafeInteger(process.pid) || process.pid <= 0 ||
          !Number.isSafeInteger(process.privateBytes) || process.privateBytes < 0 ||
          !Number.isSafeInteger(process.peakPrivateBytes) || process.peakPrivateBytes < process.privateBytes) throw new Error('Invalid private-commit measurement');
      total += process.privateBytes;
      peaks.set(process.pid, Math.max(peaks.get(process.pid) ?? 0, process.peakPrivateBytes));
    }
    peakBytes = Math.max(peakBytes, total);
    if (index) maximumSampleGapMs = Math.max(maximumSampleGapMs, sample.elapsedMs - samples[index - 1].elapsedMs);
  }
  return { metric: 'Windows private commit, summed over dedicated browser and all descendants',
    sampleCount: samples.length, intervalMs: 250, maximumSampleGapMs, peakBytes,
    perProcessPeakSumBytes: [...peaks.values()].reduce((a, b) => a + b, 0),
    limits: 'Headless only; sub-interval transients can be missed. Per-process peaks are not simultaneous.' };
}

export async function startProcessMemory(browserPid) {
  if (process.platform !== 'win32') throw new Error('Private-commit admission sampler requires Windows');
  if (!Number.isSafeInteger(browserPid) || browserPid <= 0) throw new Error('A dedicated browser PID is required');
  const script = sampler.replace('ROOT_PROCESS_ID', String(browserPid));
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const samples = [], milestones = [], waiting = new Set();
  let error, stopped = false, stderr = '';
  const fail = reason => {
    error = reason;
    for (const pending of waiting) pending.reject(reason);
    waiting.clear();
  };
  child.stderr.on('data', data => { stderr += data.toString(); });
  child.on('error', fail);
  const exited = new Promise(resolve => child.once('close', code => {
    if (!stopped) fail(new Error(`Memory sampler exited (${code}): ${stderr}`));
    resolve();
  }));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const sample = JSON.parse(line);
      summarizeProcessMemory([sample]);
      samples.push(sample);
      for (const pending of waiting) pending.resolve(sample);
      waiting.clear();
    } catch (cause) { fail(cause); }
  });
  const next = () => new Promise((resolve, reject) => {
    if (error) { reject(error); return; }
    const pending = { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: cause => { clearTimeout(timeout); reject(cause); } };
    const timeout = setTimeout(() => { waiting.delete(pending); reject(new Error('Memory sampler timed out')); }, 15000);
    waiting.add(pending);
  });
  const stop = async () => {
    stopped = true;
    child.kill();
    await exited;
    lines.close();
    for (const pending of waiting) pending.reject(new Error('Memory sampler stopped'));
    waiting.clear();
  };
  try { await next(); } catch (cause) { await stop(); throw cause; }
  return {
    async mark(name) { const sample = await next(); milestones.push({ name, elapsedMs: sample.elapsedMs,
      privateBytes: sample.processes.reduce((sum, p) => sum + p.privateBytes, 0) }); },
    report() { if (error) throw error; return { ...summarizeProcessMemory(samples), milestones, samples }; },
    stop,
  };
}
