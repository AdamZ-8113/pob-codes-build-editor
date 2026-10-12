import type { Driver } from "../upstream/packages/driver/src/js/driver.ts";
import type {
  BuildFolderImportFile,
  BuildFolderImportResult,
  BuildListState,
} from "../upstream/packages/driver/src/js/build-folder-import.ts";

export type BuildFolderImportGeometry = {
  scale: number;
  left: number;
  top: number;
  width: number;
  virtualWidth: number;
  virtualHeight: number;
};

export const WINDOWS_DEFAULT_BUILD_FOLDER_SHORTCUT = "shell:Personal\\Path of Building\\Builds";

export function buildFolderImportGeometry(state: BuildListState): BuildFolderImportGeometry {
  const scale = Number.isFinite(state.uiScale / state.pixelRatio) && state.pixelRatio > 0
    ? state.uiScale / state.pixelRatio
    : 1;
  const left = state.virtualWidth / 2 + 466;
  return {
    scale,
    left,
    top: 54,
    width: Math.max(0, Math.min(300, state.virtualWidth - left - 12)),
    virtualWidth: state.virtualWidth,
    virtualHeight: state.virtualHeight,
  };
}

export function logicalCurrentFolder(subPath: string): string {
  const parts = subPath.split("/").filter(Boolean);
  return ["Builds", ...parts].join(" > ");
}

const SAFE_IMPORT_ERRORS = new Set([
  "Folder import is unavailable in this browser.",
  "No folder was selected.",
  "The selected folder contains an unsupported path.",
  "The browser did not provide a usable folder selection.",
  "Select one folder at a time.",
  "The selected folder contains no lower-case .xml build files.",
  "One or more build files exceed the import size limit.",
  "The selected folder exceeds the import limits.",
  "There is not enough browser storage available for this folder.",
  "The build destination changed while the folder chooser was open.",
  "The configured build path is unavailable to this browser.",
  "The configured build path is outside browser-local storage.",
  "Folder import is unavailable for the cloud build directory.",
]);

export function publicBuildFolderImportError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return SAFE_IMPORT_ERRORS.has(message) ? message : "The folder could not be copied into browser storage.";
}

export type BuildFolderImportSidecar = {
  update(state: BuildListState): void;
  destroy(): void;
};

export function createBuildFolderImportSidecar(
  driver: Pick<Driver, "getSceneOverlayRoot" | "importBuildFolder">,
): BuildFolderImportSidecar {
  const overlay = driver.getSceneOverlayRoot();
  if (!overlay) throw new Error("The Path of Building scene overlay is unavailable.");

  const layer = document.createElement("div");
  layer.className = "pob-build-folder-layer";
  layer.dataset.buildFolderImportLayer = "";

  const panel = document.createElement("aside");
  panel.className = "pob-build-folder-import";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Import Build Folder");

  const description = document.createElement("p");
  description.id = "build-folder-import-description";
  description.textContent = "Choose a folder to copy its .xml builds into this browser's local storage folder.";
  const localNotice = document.createElement("p");
  localNotice.textContent = "This does not send data to pob.codes";
  const linkNotice = document.createElement("p");
  linkNotice.textContent = "This does not create a bi-directional link between the folders";
  const sourceHint = document.createElement("p");
  sourceHint.className = "pob-build-folder-source-hint";
  sourceHint.append("Copy/paste this Windows default path:");
  const sourcePath = document.createElement("code");
  sourcePath.textContent = WINDOWS_DEFAULT_BUILD_FOLDER_SHORTCUT;
  sourcePath.title = "Double-click to select the entire path";
  sourceHint.append(sourcePath);

  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".xml";
  input.className = "pob-build-folder-input";
  input.setAttribute("webkitdirectory", "");
  input.setAttribute("aria-label", "Choose a build folder");
  input.setAttribute("aria-describedby", "build-folder-import-description");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "pob-build-folder-button";
  button.textContent = "Import Folder";
  button.setAttribute("aria-describedby", "build-folder-import-description");

  const destination = document.createElement("p");
  destination.className = "pob-build-folder-destination";
  const status = document.createElement("p");
  status.className = "pob-build-folder-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "No folder was imported.";

  panel.append(description, localNotice, linkNotice, sourceHint, button, input, destination, status);
  layer.append(panel);
  overlay.append(layer);

  let currentState: BuildListState | undefined;
  let pickerState: BuildListState | undefined;
  let importing = false;

  const stop = (event: Event) => event.stopPropagation();
  for (const name of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel", "touchstart", "touchend", "keydown", "keyup"]) {
    panel.addEventListener(name, stop);
  }

  sourcePath.addEventListener("dblclick", (event) => {
    event.preventDefault();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(sourcePath);
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const restoreButtonFocus = () => {
    if (currentState?.mode === "LIST" && document.contains(button)) button.focus();
  };

  button.addEventListener("click", () => {
    if (importing || currentState?.mode !== "LIST") return;
    pickerState = { ...currentState };
    status.textContent = "Choose a folder in the browser dialog.";
    input.click();
  });

  input.addEventListener("cancel", () => {
    pickerState = undefined;
    status.textContent = "No folder was imported.";
    restoreButtonFocus();
  });

  input.addEventListener("change", async () => {
    const files = [...(input.files ?? [])] as BuildFolderImportFile[];
    input.value = "";
    // The visible button captures state before a real chooser opens. Retain a
    // direct-input fallback for assistive tooling and browser automation where
    // no chooser interval exists.
    pickerState ??= currentState ? { ...currentState } : undefined;
    if (!files.length || !pickerState) {
      status.textContent = "No folder was imported.";
      restoreButtonFocus();
      return;
    }
    importing = true;
    button.disabled = true;
    status.textContent = "Copying builds into browser storage…";
    try {
      const result: BuildFolderImportResult = await driver.importBuildFolder(files, pickerState);
      status.textContent = `Imported ${result.acceptedCount} build${result.acceptedCount === 1 ? "" : "s"} into ${result.logicalDestination}.` +
        (result.ignoredCount ? ` Ignored ${result.ignoredCount} non-build file${result.ignoredCount === 1 ? "" : "s"}.` : "");
    } catch (error) {
      status.textContent = publicBuildFolderImportError(error);
    } finally {
      importing = false;
      pickerState = undefined;
      button.disabled = currentState?.mode !== "LIST";
      restoreButtonFocus();
    }
  });

  return {
    update(state) {
      currentState = state;
      const geometry = buildFolderImportGeometry(state);
      layer.style.width = `${geometry.virtualWidth}px`;
      layer.style.height = `${geometry.virtualHeight}px`;
      layer.style.transform = `scale(${geometry.scale})`;
      panel.style.left = `${geometry.left}px`;
      panel.style.top = `${geometry.top}px`;
      panel.style.width = `${geometry.width}px`;
      panel.hidden = state.mode !== "LIST" || geometry.width < 160;
      panel.setAttribute("aria-hidden", panel.hidden ? "true" : "false");
      button.disabled = importing || state.mode !== "LIST";
      destination.textContent = `Stored in: ${logicalCurrentFolder(state.subPath)}`;
    },
    destroy() {
      layer.remove();
    },
  };
}
