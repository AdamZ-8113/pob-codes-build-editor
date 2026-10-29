describe("Packed calculator stage engagement", function()
  for _, gem in ipairs({ "Fireball", "Summon Raging Spirit" }) do
    it("executes required stages and omits unused stages for " .. gem, function()
      newBuild()
      build.skillsTab:PasteSocketGroup(gem .. " 20/0  1\n")
      for _, group in ipairs(build.skillsTab.socketGroupList) do group.includeInFullDPS = true end
      build.buildFlag = true
      runCallback("OnFrame")
      local calcs = build.calcsTab.calcs
      local calc = calcs.getMiscCalculator(build)
      local originalEHP, originalFull = calcs.buildDefenceEstimations, calcs.calcFullDPS
      local ehpCalls, fullCalls = 0, 0
      calcs.buildDefenceEstimations = function(...)
        ehpCalls = ehpCalls + 1
        return originalEHP(...)
      end
      calcs.calcFullDPS = function(...)
        fullCalls = fullCalls + 1
        return originalFull(...)
      end
      local ok, err = pcall(function()
        calc({}, false, {skipEHP=true, skipFullDPS=true})
        assert.are.equal(0, ehpCalls)
        assert.are.equal(0, fullCalls)
        calc({}, false, {skipEHP=false, skipFullDPS=true})
        assert.is_true(ehpCalls > 0)
        assert.are.equal(0, fullCalls)
        local result = calc({}, true, {skipEHP=true, skipFullDPS=false})
        assert.is_true(fullCalls > 0)
        assert.is_true(result.FullDPS > 0)
      end)
      calcs.buildDefenceEstimations, calcs.calcFullDPS = originalEHP, originalFull
      assert(ok, tostring(err))
    end)
  end
end)
