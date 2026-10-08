import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadInput } from '../../scripts/lib/fixture-loader.mjs';

test('public composite fixtures retain the equipped socket and exact family/seed text', () => {
  const names = readdirSync('fixtures').filter(name => name.endsWith('.json'));
  assert.equal(names.length, 9);
  for (const name of names) {
    const definition = JSON.parse(readFileSync('fixtures/'+name,'utf8'));
    const {xml, hash} = loadInput('fixtures/'+name);
    assert.equal(hash.length, 64);
    const item = xml.match(new RegExp(`<Item id="${definition.itemId}">([\\s\\S]*?)</Item>`))?.[1];
    assert.ok(item?.includes(definition.seedLine));
    assert.ok(item.includes(definition.itemName));
    assert.ok(xml.includes(`jewelTypeId="${definition.jewelTypeId}"`));
    if (definition.conqueror) {
      assert.ok(item.includes('Radius: Large'));
      assert.ok(!item.includes('Conquered by the Abyssal'));
    } else assert.ok(item.includes('Passives affected are Conquered by the Abyssal'));
  }
});
