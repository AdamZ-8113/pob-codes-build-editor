describe("Tree connector bounds", function()
	local tree
	before_each(function()
		newBuild()
		tree = build.spec.tree
	end)

	local function containsArtwork(connector)
		local bounds = assert(connector.bounds)
		for _, vert in pairs(connector.vert) do
			for i = 1, 8, 2 do
				assert.is_true(vert[i] >= bounds[1] and vert[i] <= bounds[3])
				assert.is_true(vert[i + 1] >= bounds[2] and vert[i + 1] <= bounds[4])
			end
		end
	end

	it("contains every artwork state of every loaded tree connector", function()
		assert.is_true(#tree.connectors > 1000)
		for _, connector in ipairs(tree.connectors) do
			containsArtwork(connector)
		end
	end)

	it("bounds a line's width, not just its node centers", function()
		local connectors = tree:BuildConnector({ id = 1, x = -100, y = 40, g = 1 }, { id = 2, x = 100, y = 40, g = 2 })
		assert.are.equal(1, #connectors)
		containsArtwork(connectors[1])
		assert.is_true(connectors[1].bounds[2] < 40)
		assert.is_true(connectors[1].bounds[4] > 40)
	end)

	it("bounds both halves of a long arc and rebuilds after group movement", function()
		local group = { x = 100, y = -200 }
		local a = { id = 1, g = 1, o = 1, angle = 0, group = group }
		local b = { id = 2, g = 1, o = 1, angle = math.pi * 0.75, group = group }
		local connectors = tree:BuildConnector(a, b)
		assert.are.equal(2, #connectors)
		for _, connector in ipairs(connectors) do containsArtwork(connector) end
		group.x, group.y = group.x + 3000, group.y - 2000
		local moved = tree:BuildConnector(a, b)
		for i, connector in ipairs(moved) do
			containsArtwork(connector)
			for axis = 1, 4 do
				assert.is_near(connectors[i].bounds[axis] + (axis % 2 == 1 and 3000 or -2000), connector.bounds[axis], 0.000001)
			end
		end
	end)

	it("leaves degenerate or incomplete geometry uncullable", function()
		local connector = { bounds = { 1, 2, 3, 4 }, vert = { Normal = { 1, 2 } } }
		tree:BuildConnectorBounds(connector)
		assert.is_nil(connector.bounds)
		for _, invalid in ipairs({ 0/0, math.huge, -math.huge }) do
			connector.vert.Normal = { 0, 0, 1, 0, 1, 1, invalid, 1 }
			tree:BuildConnectorBounds(connector)
			assert.is_nil(connector.bounds)
		end
	end)
end)

describe("Retained tree artwork", function()
	local viewer, saved, captures, replays, releases, cursorX, cursorY, held
	local viewport = { x = 300, y = 80, width = 1300, height = 900 }
	local function override(name, value)
		saved[name] = { _G[name] }
		_G[name] = value
	end
	before_each(function()
		newBuild()
		viewer = build.treeTab.viewer
		saved, captures, replays, releases = {}, 0, 0, 0
		cursorX, cursorY, held = -100, -100, true
		override("GetCursorPos", function() return cursorX, cursorY end)
		override("IsKeyDown", function(key) return key == "LEFTBUTTON" and held end)
		override("CaptureDrawCache", function(draw) captures = captures + 1; draw(); return {} end)
		override("ReplayDrawCache", function(_, dx, dy) replays = replays + 1; return true end)
		override("ReleaseDrawCache", function() releases = releases + 1 end)
		viewer.dragging, viewer.dragX, viewer.dragY = true, cursorX, cursorY
		build.buildFlag = false
	end)
	after_each(function()
		for name, value in pairs(saved) do _G[name] = value[1] end
	end)

	it("reuses a drag, then rebuilds for revision, zoom, viewport and native invalidation", function()
		viewer:Draw(build, viewport, {})
		assert.are.equal(1, captures)
		cursorX = cursorX + 20
		viewer:Draw(build, viewport, {})
		assert.are.equal(1, captures)
		assert.are.equal(1, replays)
		build.outputRevision = (build.outputRevision or 0) + 1
		viewer:Draw(build, viewport, {})
		assert.are.equal(2, captures)
		viewer.zoom = viewer.zoom * 1.2
		viewer:Draw(build, viewport, {})
		assert.are.equal(3, captures)
		viewer:Draw(build, { x = 300, y = 80, width = 1250, height = 900 }, {})
		assert.are.equal(4, captures)
		_G.ReplayDrawCache = function() return false end
		viewer:Draw(build, { x = 300, y = 80, width = 1250, height = 900 }, {})
		assert.are.equal(5, captures)
		assert.are.equal(4, releases)
	end)

	it("releases on mouse-up and uses the live path for searches, input and build edits", function()
		viewer:Draw(build, viewport, {})
		viewer.searchStr = "life"
		viewer:Draw(build, viewport, {})
		assert.are.equal(1, captures)
		assert.are.equal(1, releases)
		assert.is_nil(viewer._dragArtwork)
		viewer.searchStr = ""
		viewer:Draw(build, viewport, {})
		viewer:Draw(build, viewport, {{type="KeyUp", key="PAGEUP"}})
		assert.is_nil(viewer._dragArtwork)
		build.buildFlag = true
		viewer:Draw(build, viewport, {})
		assert.are.equal(2, captures)
		build.buildFlag = false
		viewer:Draw(build, viewport, {})
		held = false
		viewer:Draw(build, viewport, {})
		assert.are.equal(3, captures)
		assert.are.equal(3, releases)
		assert.is_nil(viewer._dragArtwork)
		assert.is_nil(viewer._dragArtworkSpec)
		assert.is_nil(viewer._dragArtworkTree)
	end)

	it("does not repeatedly capture an oversized drawing during the same drag", function()
		_G.CaptureDrawCache = function(draw) captures = captures + 1; draw(); return nil end
		viewer:Draw(build, viewport, {})
		viewer:Draw(build, viewport, {})
		assert.are.equal(1, captures)
		assert.is_true(viewer._dragArtworkUnavailable)
		build.outputRevision = (build.outputRevision or 0) + 1
		viewer:Draw(build, viewport, {})
		assert.are.equal(2, captures)
		held = false
		viewer:Draw(build, viewport, {})
		assert.is_nil(viewer._dragArtworkUnavailable)
		assert.is_nil(viewer._dragArtworkSpec)
	end)

	it("draws normally when the host does not offer retained commands", function()
		_G.CaptureDrawCache = nil
		viewer:Draw(build, viewport, {})
		assert.are.equal(0, captures)
		assert.is_nil(viewer._dragArtwork)
	end)

	it("culls full image extents, preserves half groups and captures offscreen artwork", function()
		local draws = 0
		override("DrawImage", function() draws = draws + 1 end)
		viewer._assetScreenWidth, viewer._assetScreenHeight = 100, 100
		local asset = { width = 10, height = 10 }
		viewer:DrawAsset(asset, -100, 50, 1)
		assert.are.equal(0, draws)
		viewer:DrawAsset(asset, -10, 50, 1)
		assert.are.equal(1, draws)
		viewer:DrawAsset(asset, 50, 120, 1, true)
		assert.are.equal(3, draws)
		viewer._captureTreeArtwork = true
		viewer:DrawAsset(asset, -100, 50, 1)
		assert.are.equal(4, draws)
	end)
end)
