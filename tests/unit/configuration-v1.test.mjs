import test from "node:test"; import assert from "node:assert/strict";
import { createConfigurationBridgeV1 } from "../../src/configuration-v1.ts";
import { readFile } from "node:fs/promises";
test("same-instance transactions preserve manual ownership and undo snapshots", async () => {
  let code="before"; const applied=[]; const native={async getBuildCode(){return code},async loadBuildFromCode(value){code=value},async applyConfiguration(request){applied.push(request);code="after";return {ok:true}}};
  const bridge=createConfigurationBridgeV1(native); await bridge.apply({version:1,writes:[{key:"enemyIsBoss",owner:"manual",operation:"set",value:"Pinnacle"}]});
  const result=await bridge.apply({version:1,writes:[{key:"enemyIsBoss",owner:"automatic",operation:"set",value:"Boss"},{key:"conditionFullLife",owner:"automatic",operation:"set",value:true}]});
  assert.deepEqual(result.skipped,["enemyIsBoss"]); assert.deepEqual(result.applied,["conditionFullLife"]); assert.equal(bridge.ownership("enemyIsBoss"),"manual");
  assert.equal(await bridge.undo(),true); assert.equal(code,"after"); assert.equal(applied.length,2);
});
test("native bridge targets ConfigTab on the displayed Driver instance", async () => {
  const [boot,c,worker,driver]=await Promise.all(["upstream/packages/driver/boot.lua","upstream/packages/driver/src/c/driver.c","upstream/packages/driver/src/js/worker.ts","upstream/packages/driver/src/js/driver.ts"].map(path=>readFile(path,"utf8")));
  assert.match(boot,/build\.configTab/); assert.match(boot,/configTab:AddUndoState\(\)/); assert.match(boot,/rollback/); assert.match(boot,/configTab:BuildModList\(\)/);
  assert.match(c,/apply_build_configuration/); assert.match(worker,/applyBuildConfiguration/); assert.match(driver,/driverWorker\?\.applyConfiguration/);
});
test("failed native transactions rollback the displayed instance and inputs are bounded", async () => {
  let loaded; const native={async getBuildCode(){return "snapshot"},async loadBuildFromCode(value){loaded=value},async applyConfiguration(){throw Error("native fail")}};
  const bridge=createConfigurationBridgeV1(native); await assert.rejects(bridge.apply({version:1,writes:[{key:"enemyLevel",owner:"manual",operation:"set",value:84}]}),/native fail/); assert.equal(loaded,"snapshot");
  await assert.rejects(bridge.apply({version:1,writes:[{key:"bad-key",owner:"manual",operation:"clear"}]}),/key/);
});

const levelWrite = owner => ({ version: 1, writes: [{ key: "enemyLevel", owner, operation: "set", value: 84 }] });

test("snapshot failures release the transaction lock without applying or restoring a build", async () => {
  for (const failure of ["export", "size"]) {
    let fail = true;
    let applications = 0;
    let restores = 0;
    const bridge = createConfigurationBridgeV1({
      async getBuildCode() {
        if (fail && failure === "export") throw new Error("Export unavailable");
        return fail ? "oversized snapshot" : "snapshot";
      },
      async applyConfiguration() { applications++; return { ok: true }; },
      async loadBuildFromCode() { restores++; },
    }, { maxSnapshotBytes: 8 });
    await assert.rejects(bridge.apply(levelWrite("manual")), failure === "export" ? /Export unavailable/ : /snapshot exceeds/);
    assert.equal(bridge.busy, false);
    assert.equal(bridge.generation, 0);
    assert.equal(bridge.ownership("enemyLevel"), undefined);
    assert.equal(await bridge.undo(), false);
    assert.equal(applications, 0);
    assert.equal(restores, 0);
    fail = false;
    assert.equal((await bridge.apply(levelWrite("manual"))).ok, true);
    assert.equal(applications, 1);
  }
});

test("snapshot acquisition keeps configuration transactions serialized", async () => {
  let finishSnapshot;
  const bridge = createConfigurationBridgeV1({
    getBuildCode: () => new Promise(resolve => { finishSnapshot = resolve; }),
    async applyConfiguration() { return { ok: true }; },
    async loadBuildFromCode() {},
  });
  const pending = bridge.apply(levelWrite("manual"));
  assert.equal(bridge.busy, true);
  await assert.rejects(bridge.apply(levelWrite("automatic")), /already running/);
  await assert.rejects(bridge.undo(), /already running/);
  finishSnapshot("snapshot");
  await pending;
  assert.equal(bridge.busy, false);
});

test("failed undo preserves its snapshot, ownership and generation for retry", async () => {
  let code = "initial";
  let failRestore = true;
  const restored = [];
  const bridge = createConfigurationBridgeV1({
    async getBuildCode() { return code; },
    async applyConfiguration() { code = "edited"; return { ok: true }; },
    async loadBuildFromCode(snapshot) {
      restored.push(snapshot);
      if (failRestore) throw new Error("Restore unavailable");
      code = snapshot;
    },
  });
  await bridge.apply(levelWrite("automatic"));
  await bridge.apply(levelWrite("manual"));
  await assert.rejects(bridge.undo(), /Restore unavailable/);
  assert.equal(bridge.busy, false);
  assert.equal(bridge.generation, 2);
  assert.equal(bridge.ownership("enemyLevel"), "manual");
  failRestore = false;
  assert.equal(await bridge.undo(), true);
  assert.equal(bridge.ownership("enemyLevel"), "automatic");
  assert.equal(bridge.generation, 3);
  assert.equal(await bridge.undo(), true);
  assert.equal(code, "initial");
  assert.equal(bridge.ownership("enemyLevel"), undefined);
  assert.equal(await bridge.undo(), false);
  assert.deepEqual(restored, ["edited", "edited", "initial"]);
});
