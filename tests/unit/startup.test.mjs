import assert from "node:assert/strict";
import test from "node:test";
import { createStartupPresenter, createStartupReadiness } from "../../src/startup.ts";

for (const frameFirst of [false, true]) {
  test(`readiness needs attachment and a real frame (${frameFirst ? 'frame' : 'attachment'} first)`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const startup = createStartupReadiness();
    let ready = false;
    const waiting = startup.wait().then(() => { ready = true; });
    assert.equal(startup.frame(0), false);
    if (frameFirst) assert.equal(startup.frame(12), true);
    else startup.attached();
    await Promise.resolve();
    assert.equal(ready, false);
    if (frameFirst) startup.attached();
    else assert.equal(startup.frame(12), true);
    await waiting;
    assert.equal(ready, true);
    assert.equal(startup.frame(12), false);
    t.mock.timers.tick(90_000);
    startup.assertHealthy();
  });
}

test('early, waiting and just-resolved errors cannot turn into readiness', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const phase of ['early', 'waiting', 'resolved']) {
    const startup = createStartupReadiness();
    let waiting;
    if (phase !== 'early') {
      startup.attached();
      waiting = startup.wait();
    }
    if (phase === 'resolved') startup.frame(1);
    startup.fail(new Error(phase));
    startup.attached();
    assert.equal(startup.frame(1), false);
    await assert.rejects(waiting ?? startup.wait(), new RegExp(phase));
    assert.throws(() => startup.assertHealthy(), new RegExp(phase));
    t.mock.timers.tick(90_000);
    await assert.rejects(startup.wait(), new RegExp(phase));
  }
});

test('no-frame timeout starts after attachment and ignores late frames', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const startup = createStartupReadiness();
  t.mock.timers.tick(90_001);
  startup.assertHealthy();
  startup.attached();
  t.mock.timers.tick(89_999);
  startup.assertHealthy();
  t.mock.timers.tick(1);
  await assert.rejects(startup.wait(), /did not draw/);
  assert.equal(startup.frame(1), false);
});

function presenter() {
  const surface = { hidden: false, removed: false, remove() { this.removed = true; } };
  const detail = { hidden: true, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, querySelectorAll() { return []; } };
  return { surface, detail, startup: createStartupPresenter(surface, detail) };
}

test('startup details are delayed, monotonic and stop at first frame', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { startup, surface, detail } = presenter();
  startup.update(84, 'Starting Path of Building');
  startup.update(70, 'Late download');
  t.mock.timers.tick(149);
  assert.equal(detail.hidden, true);
  t.mock.timers.tick(1);
  assert.equal(detail.hidden, false);
  assert.equal(detail.attributes['aria-valuenow'], '84');
  startup.firstFrame();
  startup.update(90, 'Late package');
  assert.equal(detail.hidden, true);
  assert.equal(surface.removed, false);
  startup.ready();
  assert.equal(surface.removed, true);
});

test('error and disposal cancel delayed details; late success cannot erase failure', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failed = presenter();
  failed.startup.error();
  failed.startup.firstFrame();
  failed.startup.ready();
  failed.startup.update(100, 'Late success');
  const disposed = presenter();
  disposed.startup.dispose();
  t.mock.timers.tick(150);
  assert.equal(failed.detail.hidden, true);
  assert.equal(failed.surface.hidden, true);
  assert.equal(failed.surface.removed, false);
  assert.equal(disposed.detail.hidden, true);
});
