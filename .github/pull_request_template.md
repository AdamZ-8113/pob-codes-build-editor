## Summary

Describe the user-visible or maintenance change and its source/provenance impact.

## Validation

- [ ] `npm run check`
- [ ] `npm run test:unit`
- [ ] Applicable native/browser/release gates

## Performance changes

For optimizations, include fixture/source/binary/browser/viewport identities,
alternating before/after runs, cold/warm medians and tails, retained-memory
bounds, cache invalidation, canonical export/tooltips, pixels where relevant,
and measurement limitations. Frame callbacks are not GPU presentation latency.

## Safety

- [ ] No private builds, account/character data, captures, credentials, reports,
  compiler output, payload output, or dependency trees are included.
- [ ] Source pins, overlays, notices, and generated outputs were updated together
  when applicable.
