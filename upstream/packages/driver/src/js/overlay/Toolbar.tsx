import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CiKeyboard } from "react-icons/ci";
import { HiMagnifyingGlass, HiOutlineChartBarSquare, HiOutlineWrenchScrewdriver } from "react-icons/hi2";
import { MdFullscreen, MdFullscreenExit } from "react-icons/md";
import { PiCursorThin } from "react-icons/pi";
import { ToolbarButton } from "./ToolbarButton.tsx";
import type { ToolbarCallbacks, ToolbarPosition } from "./types.ts";
import { useFullscreen } from "./useFullscreen.ts";
import { ZoomControl } from "./ZoomControl.tsx";

interface ToolbarProps {
  callbacks: ToolbarCallbacks;
  position: ToolbarPosition;
  isLandscape: boolean;
  panModeEnabled: boolean;
  keyboardVisible: boolean;
  performanceVisible?: boolean;
  currentZoom?: number;
  currentCanvasSize?: { width: number; height: number };
  isFixedSize?: boolean;
  externalComponent?: React.ComponentType<{ position: ToolbarPosition; isLandscape: boolean }>;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  callbacks,
  position,
  isLandscape,
  panModeEnabled,
  keyboardVisible,
  performanceVisible = false,
  currentZoom = 1.0,
  currentCanvasSize = { width: 1520, height: 800 },
  isFixedSize = false,
  externalComponent: ExternalComponent,
}) => {
  const [toolsMenuVisible, setToolsMenuVisible] = useState(false);
  const [zoomControlVisible, setZoomControlVisible] = useState(false);
  const toolsContainer = useRef<HTMLDivElement>(null);
  const { isFullscreen } = useFullscreen();

  useEffect(() => {
    if (!toolsMenuVisible) return;
    const closeOutside = (event: PointerEvent) => {
      if (!toolsContainer.current?.contains(event.target as Node)) setToolsMenuVisible(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setToolsMenuVisible(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [toolsMenuVisible]);

  const handlePanModeToggle = useCallback(() => {
    callbacks.onPanModeToggle(!panModeEnabled);
  }, [callbacks, panModeEnabled]);

  const handleToolsToggle = useCallback(() => {
    setToolsMenuVisible((visible) => {
      const next = !visible;
      if (next) setZoomControlVisible(false);
      return next;
    });
  }, []);

  const handleZoomToggle = useCallback(() => {
    setToolsMenuVisible(false);
    setZoomControlVisible((prev) => !prev);
  }, []);

  const handleFullscreenToggle = useCallback(() => {
    setToolsMenuVisible(false);
    callbacks.onFullscreenToggle();
  }, [callbacks]);

  const handleKeyboardToggle = useCallback(() => {
    setToolsMenuVisible(false);
    callbacks.onKeyboardToggle();
  }, [callbacks]);

  const containerClasses = `pw:navbar pw:bg-base-200/95 pw:shadow-lg pw:select-none pw:relative pw:gap-1 ${
    isLandscape ? "pw:flex-col pw:justify-center pw:h-full" : "pw:flex-row pw:justify-center pw:w-full"
  }`;

  const fullscreenIcon = isFullscreen ? <MdFullscreenExit size={24} /> : <MdFullscreen size={24} />;
  const fullscreenTooltip = isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen";

  return (
    <div className={containerClasses}>
      {ExternalComponent && <div className="pw:flex-grow" />}

      <div ref={toolsContainer} className="pw:relative">
        <ToolbarButton
          icon={<HiOutlineWrenchScrewdriver size={24} />}
          tooltip="WebAssembly tools"
          onClick={handleToolsToggle}
          isActive={toolsMenuVisible || panModeEnabled || keyboardVisible || zoomControlVisible || isFullscreen}
          ariaHaspopup="menu"
          ariaExpanded={toolsMenuVisible}
        />
        {toolsMenuVisible && (
          <div
            role="menu"
            aria-label="WebAssembly tools"
            className="driver-tools-menu pw:absolute pw:top-full pw:right-0 pw:z-50 pw:mt-2 pw:w-48 pw:rounded pw:border pw:border-base-300 pw:bg-base-200 pw:p-1 pw:shadow-xl"
          >
            <ToolMenuButton
              icon={<PiCursorThin size={20} />}
              label="Pointer / pan"
              active={panModeEnabled}
              onClick={handlePanModeToggle}
            />
            <ToolMenuButton
              icon={<CiKeyboard size={20} />}
              label="Virtual keyboard"
              active={keyboardVisible}
              onClick={handleKeyboardToggle}
            />
            <ToolMenuButton
              icon={<HiMagnifyingGlass size={20} />}
              label="Zoom & canvas"
              active={zoomControlVisible}
              onClick={handleZoomToggle}
            />
            <ToolMenuButton
              icon={fullscreenIcon}
              label={fullscreenTooltip}
              active={isFullscreen}
              onClick={handleFullscreenToggle}
            />
          </div>
        )}
      </div>

      <ToolbarButton
        icon={<HiOutlineChartBarSquare size={24} />}
        tooltip="Toggle runtime stats"
        onClick={callbacks.onPerformanceToggle}
        isActive={performanceVisible}
      />

      {ExternalComponent && <div className="pw:flex-grow" />}

      {ExternalComponent && <ExternalComponent position={position} isLandscape={isLandscape} />}

      <ZoomControl
        currentZoom={currentZoom}
        minZoom={0.1}
        maxZoom={2.0}
        onZoomChange={callbacks.onZoomChange}
        onZoomReset={callbacks.onZoomReset}
        onCanvasSizeChange={callbacks.onCanvasSizeChange}
        onFixedSizeToggle={callbacks.onFixedSizeToggle}
        currentCanvasSize={currentCanvasSize}
        isFixedSize={isFixedSize}
        isVisible={zoomControlVisible}
        position={position}
      />
    </div>
  );
};

const ToolMenuButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}> = ({ icon, label, active, onClick }) => (
  <button
    type="button"
    role="menuitemcheckbox"
    aria-checked={active}
    className={`pw:flex pw:min-h-9 pw:w-full pw:items-center pw:gap-2 pw:rounded pw:px-2 pw:py-1 pw:text-left pw:text-sm pw:hover:bg-base-300 ${
      active ? "pw:text-primary" : "pw:text-base-content"
    }`}
    onClick={onClick}
  >
    <span aria-hidden="true">{icon}</span>
    <span>{label}</span>
  </button>
);
