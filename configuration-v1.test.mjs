import test from "node:test"; import assert from "node:assert/strict";
import { createConfigurationBridgeV1 } from "./src/configuration-v1.js";
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
