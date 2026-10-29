import assert from 'node:assert/strict';

function beforeReturn(source, lua) {
  const marker = '\nreturn calcs';
  assert.equal(source.split(marker).length, 2, 'Expected one calculation module return');
  return source.replace(marker, `\n${lua}\nreturn calcs`);
}

// Validation-only: counters and opt-outs are inserted into routed core packages.
export function preservationTransforms(disabled = '') {
  assert.ok(['', 'relevance', 'reuse', 'stages', 'trigger'].includes(disabled));
  return [
    { path: 'Classes/CalcsTab.lua', transform(source) {
      const marker = 'function CalcsTabClass:PowerBuilder(disableRelevance)\n';
      assert.equal(source.split(marker).length, 2, 'Expected packaged report builder');
      for (const method of ['CreateNodePowerCalculator', 'EvaluateNodePowerItem']) {
        assert.equal(source.split(`function CalcsTabClass:${method}(`).length, 2, `Expected packaged ${method} seam`);
      }
      const counters = '{ relevanceEligible = 0, relevanceSkipped = 0, setupReused = 0, ehpSkipped = 0, ehpRun = 0, fullSkipped = 0, fullRun = 0, triggerCacheHits = 0, rejectedProbeHits = 0 }';
      return source.replace(marker, marker + `\t__preservationUi = true\n\t__preservation = ${counters}\n`) + `
-- Helpers call this factory without running the UI report builder. Emit one
-- bounded proof only after both optimizations have actually done helper work.
do
  local create = CalcsTabClass.CreateNodePowerCalculator
  local evaluate = CalcsTabClass.EvaluateNodePowerItem
  function CalcsTabClass:CreateNodePowerCalculator(...)
    if not __preservationUi then __preservation = ${counters}; __preservationHelperReported = false end
    return create(self, ...)
  end
  function CalcsTabClass:EvaluateNodePowerItem(...)
    local result = evaluate(self, ...)
    if not __preservationUi and not __preservationHelperReported and __preservation and __preservation.relevanceSkipped > 0 and __preservation.setupReused > 0 then
      __preservationHelperReported = true
      print("PRESERVATION_HELPER " .. require("dkjson").encode(__preservation))
    end
    return result
  end
end
`;
    } },
    { path: 'Modules/CalcRelevance.lua', transform: source => beforeReturn(source, `
local originalCanSkip = relevance.CanSkip
function relevance:CanSkip(override)
  local eligible = originalCanSkip(self, override)
  if eligible and __preservation then __preservation.relevanceEligible = __preservation.relevanceEligible + 1 end
  local skipped = eligible and ${disabled === 'relevance' ? 'false' : 'true'}
  if skipped and __preservation then __preservation.relevanceSkipped = __preservation.relevanceSkipped + 1 end
  return skipped
end`) },
    { path: 'Modules/CalcSetupReuse.lua', transform: source => beforeReturn(source, `
local originalInitEnv = setupReuse.InitEnv
function setupReuse:InitEnv(override)
  if __preservation then __preservation.setupReused = __preservation.setupReused + 1 end
  return originalInitEnv(self, override)
end
${disabled === 'reuse' ? 'function calcs.newSetupReuse(build) return nil end' : ''}`) },
    { path: 'Modules/CalcTriggers.lua', transform(source) {
      const marker = '\tlocal reused = sourceCache and sourceCache[uuid]';
      if (!source.includes(marker)) {
        assert.notEqual(disabled, 'trigger', 'The historical baseline has no trigger cache to ablate');
        assert.equal(source.split('local function findTriggerSkill(env, skill, source, triggerRate, comparer)\n').length, 2, 'Exact historical trigger seam');
        return source;
      }
      assert.equal(source.split(marker).length, 2, 'Unique per-override trigger-cache seam');
      return source.replace(marker, `${disabled === 'trigger' ? '\tsourceCache = nil\n' : ''}${marker}
        if reused and __preservation then
          __preservation.triggerCacheHits = __preservation.triggerCacheHits + 1
          if reused.rejectedOutput then __preservation.rejectedProbeHits = __preservation.rejectedProbeHits + 1 end
        end`);
    } },
    { path: 'Modules/Calcs.lua', transform(source) {
      const perform = '\t\tcalcs.perform(env, options and options.skipEHP)';
      const full = '\t\tif calculateFullDPS and usedFullDPS then';
      assert.equal(source.split(perform).length, 2, 'Unique override stage seam');
      assert.equal(source.split(full).length, 2, 'Unique override roll-up seam');
      const force = disabled === 'stages' ? `
        local originalOptions = options
        options = { }
        for key, value in pairs(originalOptions or { }) do options[key] = value end
        options.skipEHP, options.skipFullDPS = false, false
` : '';
      return source.replace(perform, `${force}
        if __preservation then
          local key = options and options.skipEHP and "ehpSkipped" or "ehpRun"
          __preservation[key] = __preservation[key] + 1
        end
${perform}`).replace(full, `
        if __preservation and usedFullDPS then
          local key = calculateFullDPS and "fullRun" or "fullSkipped"
          __preservation[key] = __preservation[key] + 1
        end
${full}`);
    } },
  ];
}

export const transforms = preservationTransforms();
