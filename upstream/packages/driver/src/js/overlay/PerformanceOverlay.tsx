import type React from "react";
import { useCallback, useMemo, useState } from "react";
import type { GlyphAtlasStats } from "../renderer/text.ts";
import type { BackendStats } from "../renderer/backend.ts";

export interface FrameData {
  at: number;
  renderTime: number;
}

export type DebugReportAction = "copy" | "download";

export interface LayerStats {
  layer: number;
  sublayer: number;
  totalCommands: number;
  drawImageCount: number;
  drawImageQuadCount: number;
  drawStringCount: number;
}

export interface RenderStats {
  totalLayers: number;
  layerStats: LayerStats[];
  lastFrameTime: number;
  layerIndexTime: number;
  compileSubmitTime: number;
  frameCount: number;
  glyphAtlas: GlyphAtlasStats;
  backend: BackendStats;
  wasmMemoryBytes?: number;
}

interface PerformanceOverlayProps {
  isVisible: boolean;
  frames: FrameData[];
  renderStats: RenderStats | null;
  onDebugReport?: (action: DebugReportAction) => Promise<void>;
  onLayerVisibilityChange?: (layer: number, sublayer: number, visible: boolean) => void;
}

export const PerformanceOverlay: React.FC<PerformanceOverlayProps> = ({
  isVisible,
  frames,
  renderStats,
  onDebugReport,
  onLayerVisibilityChange,
}) => {
  if (!isVisible) {
    return null;
  }

  return (
    <section
      aria-label="Runtime stats"
      className="driver-runtime-stats pw:absolute pw:bottom-3 pw:right-3 pw:max-h-72 pw:w-72 pw:overflow-auto pw:rounded pw:border pw:border-base-300 pw:bg-base-100/95 pw:p-3 pw:shadow-xl pw:backdrop-blur-sm pw:space-y-2 pw:pointer-events-auto"
    >
      <div className="pw:text-xs pw:font-semibold pw:uppercase pw:tracking-wide pw:text-base-content/70">
        Runtime stats
      </div>
      <LineChart data={frames} />
      {onDebugReport && <DebugReportActions onDebugReport={onDebugReport} />}
      {renderStats && (
        <RenderStatsView stats={renderStats} frames={frames} onLayerVisibilityChange={onLayerVisibilityChange} />
      )}
    </section>
  );
};

function DebugReportActions({ onDebugReport }: { onDebugReport: (action: DebugReportAction) => Promise<void> }) {
  const [state, setState] = useState<"idle" | "working" | "copied" | "downloaded" | "error">("idle");

  const run = useCallback(async (action: DebugReportAction) => {
    if (state === "working") return;
    setState("working");
    try {
      await onDebugReport(action);
      setState(action === "copy" ? "copied" : "downloaded");
    } catch (error) {
      console.warn("Debug report action failed", error);
      setState("error");
    }
  }, [onDebugReport, state]);

  return (
    <div className="pw:space-y-1 pw:border-t pw:border-base-300 pw:pt-2">
      <div className="pw:grid pw:grid-cols-2 pw:gap-1">
        <button
          type="button"
          disabled={state === "working"}
          onClick={() => void run("copy")}
          className="btn"
        >
          Copy debug report
        </button>
        <button
          type="button"
          disabled={state === "working"}
          onClick={() => void run("download")}
          className="btn"
        >
          Download JSON
        </button>
      </div>
      <div aria-live="polite" className="pw:min-h-4 pw:text-[11px] pw:text-base-content/60">
        {state === "working"
          ? "Collecting sanitized diagnostics…"
          : state === "copied"
          ? "Debug report copied."
          : state === "downloaded"
          ? "Debug report downloaded."
          : state === "error"
          ? "Could not create the report."
          : "Excludes build and account data."}
      </div>
    </div>
  );
}

function LineChart({ data }: { data: FrameData[] }) {
  const scaleX = 1;
  const scaleY = 1;

  const chart = useMemo(() => {
    if (data.length === 0) {
      return {
        svg: null,
        max: 0,
        avg: 0,
      };
    }

    const ats = data.map((_) => _.at);
    const renderTimes = data.map((_) => _.renderTime);
    const minX = Math.min(...ats);
    const maxX = Math.max(...ats);
    const minY = 0;
    const maxY = Math.max(...renderTimes);

    const series = data.reduce(
      (acc, _value, index) => {
        if (index > 0) {
          acc.push({
            x1: data[index - 1].at,
            y1: maxY - data[index - 1].renderTime,
            x2: data[index].at,
            y2: maxY - data[index].renderTime,
          });
        }
        return acc;
      },
      [] as { x1: number; y1: number; x2: number; y2: number }[],
    );

    return {
      svg: (
        <svg
          className="pw:absolute pw:top-0 pw:left-0 pw:w-full pw:h-full pw:bg-neutral pw:text-neutral-content pw:border pw:border-neutral-content pw:py-2"
          viewBox={`${minX * scaleX} ${minY * scaleY} ${Math.max(1, maxX - minX) * scaleX} ${Math.max(1, maxY - minY) * scaleY}`}
          preserveAspectRatio="none"
        >
          <title>Render performance</title>
          {series.map((line, index) => (
            <line
              key={`${line.x1}-${index}`}
              x1={line.x1 * scaleX}
              y1={line.y1 * scaleY}
              x2={line.x2 * scaleX}
              y2={line.y2 * scaleY}
              stroke="currentColor"
              strokeWidth="2"
            />
          ))}
        </svg>
      ),
      max: maxY,
      avg: renderTimes.reduce((acc, value) => acc + value, 0) / renderTimes.length,
    };
  }, [data]);

  return (
    <div className="pw:relative pw:h-12 pw:w-full">
      {chart.svg}
      {Number.isFinite(chart.max) && (
        <span className="pw:absolute pw:bottom-1 pw:left-1 pw:p-1 pw:text-xs pw:bg-neutral pw:text-neutral-content pw:rounded">
          Max {chart.max.toFixed(1)}ms Avg {chart.avg.toFixed(1)}ms
        </span>
      )}
    </div>
  );
}

function RenderStatsView({
  stats,
  frames,
  onLayerVisibilityChange,
}: {
  stats: RenderStats | null;
  frames: FrameData[];
  onLayerVisibilityChange?: (layer: number, sublayer: number, visible: boolean) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [showLayers, setShowLayers] = useState(false);
  const [layerVisibility, setLayerVisibility] = useState<Map<string, boolean>>(new Map());

  if (!stats) {
    return null;
  }

  const summary = {
    totalLayers: stats.totalLayers,
    totalDrawImage: stats.layerStats.reduce((sum, layer) => sum + layer.drawImageCount, 0),
    totalDrawImageQuad: stats.layerStats.reduce((sum, layer) => sum + layer.drawImageQuadCount, 0),
    totalDrawString: stats.layerStats.reduce((sum, layer) => sum + layer.drawStringCount, 0),
    frameTime: stats.lastFrameTime.toFixed(1),
    frameCount: stats.frameCount,
  };
  const layerDetails = stats.layerStats;

  const totalDrawCalls = summary.totalDrawImage + summary.totalDrawImageQuad + summary.totalDrawString;
  const recentFrames = frames.slice(-60);
  const busyMs = recentFrames.reduce((total, frame) => total + frame.renderTime, 0);
  const elapsedMs = recentFrames.length > 1
    ? Math.max(1_000, recentFrames.at(-1)!.at - recentFrames[0].at)
    : 1_000;
  const cpuEstimate = Math.min(100, busyMs / elapsedMs * 100);
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;

  const toggleLayerVisibility = useCallback(
    (layer: number, sublayer: number) => {
      const layerKey = `${layer}.${sublayer}`;
      const currentVisibility = layerVisibility.get(layerKey) ?? true;
      const newVisibility = !currentVisibility;

      setLayerVisibility((prev) => {
        const newMap = new Map(prev);
        newMap.set(layerKey, newVisibility);
        return newMap;
      });

      onLayerVisibilityChange?.(layer, sublayer, newVisibility);
    },
    [layerVisibility, onLayerVisibilityChange],
  );

  return (
    <div className="pw:space-y-2 pw:text-xs">
      <div className="pw:grid pw:grid-cols-2 pw:gap-x-3 pw:gap-y-1">
        <Stat label="Wasm memory" value={formatBytes(stats.wasmMemoryBytes)} />
        <Stat label="JS heap" value={formatBytes(memory?.usedJSHeapSize)} />
        <Stat label="PoB CPU (est.)" value={`${cpuEstimate.toFixed(1)}%`} />
        <Stat label="CPU threads" value={String(navigator.hardwareConcurrency || "—")} />
        <Stat label="Frame" value={`${summary.frameTime} ms`} />
        <Stat label="Frame max" value={`${Math.max(0, ...recentFrames.map((frame) => frame.renderTime)).toFixed(1)} ms`} />
        <Stat label="Renderer" value={stats.backend.name} />
        <Stat label="Draw calls" value={String(totalDrawCalls)} />
      </div>

      <button
        type="button"
        aria-expanded={showDetails}
        onClick={() => setShowDetails((visible) => !visible)}
        className="pw:w-full pw:rounded pw:px-1 pw:py-0.5 pw:text-left pw:font-semibold pw:hover:bg-base-200"
      >
        Details {showDetails ? "▼" : "▶"}
      </button>

      {showDetails && (
        <div className="pw:grid pw:grid-cols-2 pw:gap-x-3 pw:gap-y-1">
          <Stat label="Frame count" value={String(summary.frameCount)} />
          <Stat label="Layers" value={String(summary.totalLayers)} />
          <Stat label="Images" value={String(summary.totalDrawImage)} />
          <Stat label="Quads" value={String(summary.totalDrawImageQuad)} />
          <Stat label="Text" value={String(summary.totalDrawString)} />
          <Stat label="Glyphs" value={String(stats.glyphAtlas.glyphQuads)} />
          <Stat label="Atlas pages" value={String(stats.glyphAtlas.pages)} />
          <Stat label="Instances" value={String(stats.backend.instances)} />
          <Stat label="Upload" value={formatBytes(stats.backend.instanceBytes)} />
          <Stat label="Dispatches" value={String(stats.backend.dispatches)} />
        </div>
      )}

      {showDetails && layerDetails.length > 0 && (
        <div className="pw:space-y-1">
          <button
            type="button"
            onClick={() => setShowLayers(!showLayers)}
            className="pw:font-semibold pw:text-xs pw:hover:bg-base-200 pw:px-1 pw:rounded pw:cursor-pointer"
          >
            Layers {showLayers ? "▼" : "▶"}
          </button>
          {showLayers && (
            <div className="pw:max-h-24 pw:overflow-y-auto pw:space-y-0.5">
              {layerDetails.map((layer: LayerStats) => {
                const layerTotal = layer.drawImageCount + layer.drawImageQuadCount + layer.drawStringCount;
                if (layerTotal === 0) return null;

                const layerKey = `${layer.layer}.${layer.sublayer}`;
                const isVisible = layerVisibility.get(layerKey) ?? true;

                return (
                  <div key={layerKey} className="pw:text-xs pw:font-mono pw:flex pw:items-center pw:gap-1">
                    <button
                      type="button"
                      onClick={() => toggleLayerVisibility(layer.layer, layer.sublayer)}
                      className={`pw:w-3 pw:h-3 pw:text-xs pw:border pw:rounded ${
                        isVisible ? "pw:bg-green-500 pw:text-white" : "pw:bg-red-500 pw:text-white"
                      }`}
                    >
                      {isVisible ? "●" : "○"}
                    </button>
                    <span className={isVisible ? "" : "pw:opacity-50"}>
                      L{layer.layer}.{layer.sublayer}: {layer.totalCommands}c {layerTotal}d (I{layer.drawImageCount} Q
                      {layer.drawImageQuadCount} T{layer.drawStringCount})
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="pw:min-w-0">
      <div className="pw:text-base-content/60">{label}</div>
      <div className="pw:whitespace-nowrap pw:font-mono" title={value}>{value}</div>
    </div>
  );
}

function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || !bytes) return "—";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}
