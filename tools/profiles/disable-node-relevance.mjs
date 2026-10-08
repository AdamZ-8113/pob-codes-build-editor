import assert from 'node:assert/strict';

// Validation-only payload transform. The shipped calculator is unchanged.
export const transforms = [{
  path: 'Classes/CalcsTab.lua',
  transform(source) {
    const marker = 'function CalcsTabClass:PowerBuilder(disableRelevance)\n';
    assert.equal(source.split(marker).length, 2, 'Expected the private relevance validation seam exactly once');
    return source.replace(marker, marker + '\tdisableRelevance = true\n');
  },
}];
