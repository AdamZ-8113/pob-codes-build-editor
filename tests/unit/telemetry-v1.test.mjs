import test from "node:test"; import assert from "node:assert/strict";
import { createTelemetryV1, TELEMETRY_EVENTS_V1, validateTelemetryEventV1 } from "../../src/telemetry-v1.js";
const version="0123456789abcdef01234567", sessionId="pobcs_0123456789abcdef";
test("legacy-single events match the ingestion validator shape", () => {
  const sent=[]; const telemetry=createTelemetryV1({endpoint:"https://api.pob.codes/analytics/events",hostname:"pob.codes",pathname:"/import/",appVersion:version,sessionId,deviceClass:"desktop",send:(...args)=>sent.push(args)});
  telemetry.emit("build_editor_open_v1",{result:"opened",actionTarget:"direct"});
  assert.equal(sent.length,1); const event=JSON.parse(sent[0][1]); assert.deepEqual(validateTelemetryEventV1(event),event);
  assert.deepEqual(Object.keys(event).sort(),["actionTarget","appVersion","deviceClass","eventName","result","route","sessionId"].sort()); assert.equal(event.route,"GET /import/");
});
test("all five v1 events use valid dimensions and local hosts remain disabled", () => {
  assert.equal(TELEMETRY_EVENTS_V1.length,5); const sent=[]; const telemetry=createTelemetryV1({endpoint:"https://api.pob.codes/analytics/events",hostname:"pob.codes",pathname:"/import2/",appVersion:version,sessionId,send:(_u,b)=>sent.push(JSON.parse(b))});
  telemetry.emit("build_editor_ready_v1",{result:"ready",actionTarget:"cold",durationMs:10}); telemetry.emit("build_editor_import_v1",{result:"success",actionTarget:"code"}); telemetry.emit("build_editor_export_v1",{result:"cancelled",actionTarget:"xml"}); telemetry.emit("build_editor_error_v1",{result:"error",actionTarget:"runtime",errorCode:"runtime"});
  assert.equal(sent.length,4); sent.forEach(validateTelemetryEventV1);
  const local=createTelemetryV1({endpoint:"https://api.pob.codes/analytics/events",hostname:"localhost",appVersion:version,sessionId,send(){throw Error("must not send")}}); assert.equal(local.enabled,false);
  assert.doesNotThrow(()=>createTelemetryV1({endpoint:"/analytics/events",hostname:"pob.codes",appVersion:version,sessionId,send(){throw Error("offline")}}).emit("build_editor_error_v1",{result:"error",actionTarget:"runtime",errorCode:"runtime"}));
});
