import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFolderImportGeometry,
  logicalCurrentFolder,
  publicBuildFolderImportError,
  WINDOWS_DEFAULT_BUILD_FOLDER_SHORTCUT,
} from "../../src/build-folder-import.ts";

const state = {
  mode: "LIST",
  subPath: "Ruthless/Nested/",
  buildPath: "/app/user/Path of Building/Builds/",
  virtualWidth: 1550,
  virtualHeight: 800,
  uiScale: 1,
  pixelRatio: 1,
};

test("build-folder sidecar follows native virtual geometry and UI scale", () => {
  assert.deepEqual(buildFolderImportGeometry(state), {
    scale: 1,
    left: 1241,
    top: 54,
    width: 297,
    virtualWidth: 1550,
    virtualHeight: 800,
  });
  assert.equal(buildFolderImportGeometry({ ...state, uiScale: 1.5 }).scale, 1.5);
  assert.equal(buildFolderImportGeometry({ ...state, pixelRatio: 2 }).scale, 0.5);
  assert.equal(logicalCurrentFolder(state.subPath), "Builds > Ruthless > Nested");
  assert.equal(WINDOWS_DEFAULT_BUILD_FOLDER_SHORTCUT, "shell:Personal\\Path of Building\\Builds");
});

test("build-folder errors expose only fixed privacy-bounded messages", () => {
  assert.equal(
    publicBuildFolderImportError(new Error("The selected folder exceeds the import limits.")),
    "The selected folder exceeds the import limits.",
  );
  assert.equal(
    publicBuildFolderImportError(new Error("/private/source/build.xml failed")),
    "The folder could not be copied into browser storage.",
  );
});
