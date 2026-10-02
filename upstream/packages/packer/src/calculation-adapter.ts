/** Extract the existing exact rebuild block; never duplicate or rewrite its math. */
export function exposeExactRebuild(source: string): string {
  const start = "\tif self.buildFlag then\n\t\t-- Wipe Global Cache";
  const end = "\tif main.showThousandsSeparators ~= self.lastShowThousandsSeparators then";
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to < 0 || source.indexOf(start, from + 1) >= 0 ||
    source.includes("DesktopEnsureOutputs") || source.split("return buildMode").length !== 2) {
    throw new Error("Desktop calculation adapter: upstream rebuild boundary changed");
  }
  const block = source.slice(from, to);
  for (const required of ["self.outputRevision = self.outputRevision + 1", "self.skillsTab:UpdateSocketGroups()",
    "self.calcsTab:BuildOutput()", "self:RefreshStatList()", "self.calcsTab:GetMiscCalculator()"] ) {
    if (!block.includes(required)) throw new Error("Desktop calculation adapter: rebuild semantics changed");
  }
  return (source.slice(0, from) + "\tself:DesktopEnsureOutputs()\n" + source.slice(to))
    .replace("return buildMode", `function buildMode:DesktopEnsureOutputs()\n${block}end\n\nreturn buildMode`);
}
