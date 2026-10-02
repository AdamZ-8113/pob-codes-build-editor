# Contributing

Install the pinned tools described in `README.md`, then run:

```text
npm ci
npm run prepare
npm run check
npm run test:unit
```

Add focused coverage for changed behavior. Runtime or payload changes also need
native and representative headless-browser acceptance. Release-affecting work
must keep full source/patch/package/release hash verification.

Optimization pull requests should include the fixture, source and binary
identities, browser/version/viewport, alternating before/after samples, cold and
warm results, median and tail measurements, retained-memory bounds, cache
invalidation coverage, and correctness evidence (tooltips, canonical exports,
and pixels when rendering changes). State limitations plainly; callback timing
is not GPU presentation latency.

Do not commit private build codes, account or character data, OAuth material,
captures, browser profiles, reports containing raw inputs, generated payloads,
compiler output, dependencies, or credentials. Use the public fixtures or pass
private inputs locally.

By contributing, you agree that your changes are provided under this
repository's MIT License while preserving all applicable third-party terms.
