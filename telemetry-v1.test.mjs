import test from "node:test"; import assert from "node:assert/strict";
import { createTelemetryV1, TELEMETRY_EVENTS_V1 } from "./src/telemetry-v1.js";
test("v1 telemetry is bounded, production-only, and fail-open", () => {
  assert.equal(TELEMETRY_EVENTS_V1.length, 5); const sent=[];
  const local=createTelemetryV1({endpoint:"/t",hostname:"localhost",send:(...args)=>sent.push(args)}); local.emit("editor_open_v1"); assert.equal(sent.length,0);
  const prod=createTelemetryV1({endpoint:"/t",hostname:"pob.codes",release:"abc",send:(...args)=>sent.push(args)}); prod.emit("editor_ready_v1"); prod.emit("unknown");
  assert.equal(sent.length,1); assert.deepEqual(Object.keys(JSON.parse(sent[0][1])).sort(),["contractVersion","name","outcome","release"]);
  assert.doesNotThrow(()=>createTelemetryV1({endpoint:"/t",hostname:"pob.codes",send(){throw Error("offline")}}).emit("editor_error_v1","error"));
});
