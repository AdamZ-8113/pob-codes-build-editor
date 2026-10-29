-- Public synthetic inputs derived from upstream TestTriggers' cost-override
-- regression. Run with LuaJIT from the selected PoB src directory; /fixtures
-- must be a disposable output mount. No imported account/build data is used.
package.path = "../runtime/lua/?.lua;../runtime/lua/?/init.lua;" .. package.path
dofile("HeadlessWrapper.lua")
for _, resource in ipairs({ "Mana", "Life" }) do
  newBuild()
  local foulborn = resource == "Life"
  local name = foulborn and "Foulborn Kitava's Thirst" or "Kitava's Thirst"
  local threshold = foulborn and 200 or 100
  build.itemsTab:CreateDisplayItemFromRaw("Rarity: UNIQUE\n" .. name .. "\nZealot Helmet\nImplicits: 0\n50% chance to Trigger Socketed Spells when you Spend at least " .. threshold .. " " .. resource .. " on an Upfront Cost to Use or Trigger a Skill, with a 0.1 second Cooldown")
  build.itemsTab:AddDisplayItem()
  build.configTab.input.customMods = "2000% increased Cost of Skills\n100% increased Cast Speed" .. (foulborn and "\nSkills Cost Life instead of Mana" or "")
  build.configTab:BuildModList()
  for _, group in ipairs({ "Slot: Helmet\nArc", "Slot: Body Armour\nFireball", "Slot: Helmet\nIce Nova", "Slot: Helmet\nSpark" }) do
    build.skillsTab:PasteSocketGroup(group .. " 20/0  1\n")
  end
  for _, group in ipairs(build.skillsTab.socketGroupList) do group.includeInFullDPS = true end
  build.skillsTab:PasteSocketGroup("Slot: Gloves\nClarity 1/0  1\n")
  build.buildFlag = true
  runCallback("OnFrame")
  assert(build.calcsTab.mainOutput.FullDPS > 0)
  local file = assert(io.open("/fixtures/" .. (foulborn and "foulborn" or "kitava") .. "-trigger-preservation.xml", "w"))
  file:write((assert(build:SaveDB("preservation")):gsub("\n[ \t]+\n", "\n\n")))
  file:close()
end
