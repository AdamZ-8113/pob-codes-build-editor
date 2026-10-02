import { assertEquals } from '@std/assert';
import { runtimeGcPause } from '../../src/js/gc-policy.ts';

Deno.test('GC policy separates UI and helper roles and exposes original behavior', () => {
  assertEquals(runtimeGcPause('', 'ui'), 100);
  assertEquals(runtimeGcPause('', 'helper'), 400);
  assertEquals(runtimeGcPause('?gcPause=400&helperGcPause=100', 'ui'), 400);
  assertEquals(runtimeGcPause('?gcPause=400&helperGcPause=100', 'helper'), 100);
});
Deno.test('invalid GC settings cannot disable collection or request unbounded pauses', () => {
  for (const value of ['', '0', '-1', '99', '401', 'Infinity', 'NaN', '200.5', '2e2', '200junk']) {
    assertEquals(runtimeGcPause('?gcPause=' + value, 'ui'), 100);
    assertEquals(runtimeGcPause('?helperGcPause=' + value, 'helper'), 400);
  }
});
