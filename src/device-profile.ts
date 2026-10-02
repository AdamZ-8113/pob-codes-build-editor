/** Selected once, before constructing any workers. Viewport size is not a device signal. */
export type DevicePolicy = Readonly<{
  kind: "desktop" | "mobile";
  reason: string;
  manualComparisons: boolean;
  explicitStatSort: boolean;
  pixelRatioCap: number;
  minimumInitialScale: number;
  helpers: boolean;
  prefetch: boolean;
  manualCalculations: false;
}>;

export function selectDevicePolicy(device: {
  userAgent?: string; platform?: string; maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean };
}, override?: string | null, mobilePixelRatioCap = 1.5): DevicePolicy {
  const ua = device.userAgent ?? "";
  const reason = override === "mobile" || override === "desktop" ? `local override: ${override}`
    : device.userAgentData?.mobile ? "mobile client hint"
    : /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ? "phone or tablet user agent"
    : device.platform === "MacIntel" && (device.maxTouchPoints ?? 0) > 1 ? "iPadOS desktop user agent"
    : "desktop default";
  const mobile = override === "mobile" || (override !== "desktop" && reason !== "desktop default");
  return Object.freeze({ kind: mobile ? "mobile" : "desktop", reason,
    manualComparisons: mobile, explicitStatSort: mobile,
    pixelRatioCap: mobile ? mobilePixelRatioCap : Number.MAX_VALUE,
    minimumInitialScale: mobile ? 1.5 : 0,
    helpers: !mobile, prefetch: !mobile, manualCalculations: false });
}
