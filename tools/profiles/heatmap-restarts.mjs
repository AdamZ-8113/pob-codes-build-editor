import assert from 'node:assert/strict';

// Build codes and snapshot text remain in the caller's memory. A fresh-import
// reference is established once per arm/case and reused by exact parity checks.
export async function runRestartScenarios({ arm, round, warm, input, page, state, profile, flush, select, clickControl, clickPoint, waitRun, freshReferences, report, setStage }) {
  const cases = [
    { name: 'metric-during-heatmap', phase: 'heatmap', metric: 'Life', depth: '5' },
    { name: 'metric-during-report', phase: 'report', metric: 'Life', depth: '5' },
    { name: 'depth-during-report', phase: 'report', metric: 'Hit DPS', depth: '10' },
    { name: 'allocation-during-report', phase: 'report', metric: 'Hit DPS', depth: '5' },
  ];
  const prepare = async (code, metric, depth) => {
    await page.evaluate(value => window.__DESKTOP_POB__.loadBuildFromCode(value), code);
    await page.keyboard.press('Control+1'); await flush();
    if ((await state()).enabled) await clickControl('heatmap');
    await select('depth', depth);
    await clickControl('heatmap');
    // Ensure the final native selection starts a new, identifiable run.
    await select('metric', metric === 'Hit DPS' ? 'Life' : 'Hit DPS');
    if (!(await state()).reportShown) await clickControl('report');
    const previous = (await state()).runs.at(-1)?.id ?? 0;
    const startedAt = await select('metric', metric);
    assert.notEqual(startedAt, false);
    return { previous, startedAt };
  };
  for (let cycle = 0; cycle <= warm; cycle++) for (const testCase of cases) {
    const sample = cycle === 0 ? 'cold' : `warm-${cycle}`;
    setStage(`${arm}:${round}:${sample}:${testCase.name}`);
    const initial = await prepare(input.buildCode, 'Hit DPS', '5');
    let abandoned;
    do {
      await page.waitForTimeout(40);
      abandoned = (await state()).runs.at(-1);
      if (abandoned?.id > initial.previous) {
        assert.equal(abandoned.reportReadyAt, undefined, 'Interrupt before the old report publishes');
        const reached = testCase.phase === 'heatmap'
          ? !abandoned.heatmapReadyAt && abandoned.calculators.singleAdd.count > 0
          : (abandoned.token == null || abandoned.phase === 'report') && abandoned.calculators.pathAdd.count > 0;
        if (reached) break;
      }
      assert.ok(performance.now() - initial.startedAt < 240000, 'Restart phase deadline');
    } while (true);

    let start;
    if (testCase.name.startsWith('metric-')) start = await select('metric', testCase.metric);
    else if (testCase.name.startsWith('depth-')) start = await select('depth', testCase.depth);
    else {
      const before = (await profile(true)).samples.nodePower;
      const target = before.allocationTarget;
      assert.ok(target, 'Visible adjacent normal node available for real allocation click');
      start = await clickPoint(target.x, target.y);
      const after = await state();
      assert.equal(after.allocatedNodes, before.allocatedNodes + 1, 'Native click allocated one adjacent node');
    }
    assert.notEqual(start, false, 'Restart input changes native state');
    const final = await waitRun(abandoned.id, start, testCase.metric, `${sample}:${testCase.name}`, {
      requireReport: true, expectedDepth: testCase.depth, parityGroup: testCase.name, deferOpen: false,
    });
    const old = (await state()).runs.find(run => run.id === abandoned.id);
    assert.ok(old.abandonedAt != null, 'Old run marked abandoned');
    assert.equal(old.reportCallbacks, 0, 'Abandoned run never publishes a report');
    assert.equal(old.heatmapCallbacks, abandoned.heatmapCallbacks, 'No heatmap publication after superseding the old run');
    assert.equal(old.reportReadyAt, undefined, 'Abandoned run has no completion time');

    const referenceKey = `${arm}/${testCase.name}`;
    if (!freshReferences.has(referenceKey)) {
      // Include the actual allocation in the reference input, without writing it.
      const code = await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
      const fresh = await prepare(code, testCase.metric, testCase.depth);
      await waitRun(fresh.previous, fresh.startedAt, testCase.metric, `fresh:${testCase.name}`, {
        requireReport: true, expectedDepth: testCase.depth, parityGroup: testCase.name, deferOpen: false,
      });
      freshReferences.add(referenceKey);
    }
    report.restarts.push({ arm, round, sample, case: testCase.name, abandonedRun: abandoned.id,
      finalRun: final.id, abandonedReportCallbacks: old.reportCallbacks, snapshots: final.snapshots,
      abandonedHeatmapCallbacksUnchanged: true, freshReferenceMatched: true, passed: true });
    console.log(JSON.stringify({ arm, round, sample, restart: testCase.name, passed: true }));
  }
}
