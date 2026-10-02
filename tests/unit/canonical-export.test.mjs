import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalExportTree as canonical } from '../../scripts/lib/canonical-export.mjs';
const input = (name,value) => ['Input',[['name',name],['number',value]],[]];
test('canonical exports ignore only documented unordered maps', () => {
  const a = ['ConfigSet',[],[input('a','1'),input('b','2')]];
  const b = ['ConfigSet',[],[input('b','2'),input('a','1')]];
  assert.deepEqual(canonical(a), canonical(b));
  assert.notDeepEqual(canonical(a),canonical(['ConfigSet',[],[input('a','2'),input('b','2')]]));
});
test('canonical exports preserve gem order, all text and numeric differences', () => {
  const a=['Skill',[],[['Gem',[['name','a']],[]],['Gem',[['name','b']],[]],'all text']];
  assert.notDeepEqual(canonical(a),canonical(['Skill',[],[a[2][1],a[2][0],'all text']]));
  assert.notDeepEqual(canonical(a),canonical(['Skill',[],[a[2][0],a[2][1],'changed text']]));
});
test('duplicate map identities are rejected instead of hidden by sorting', () => {
  assert.throws(() => canonical(['ConfigSet',[],[input('a','1'),input('a','2')]]),/Duplicate/);
});
