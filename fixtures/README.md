# Public test fixtures

These fixtures are reviewed, repository-owned Path of Building exports used by
unit, native, and browser acceptance. JSON fixtures compose a sibling public
base build through `fixture-loader.mjs`; they have no dependency on the PoB
Codes private application, normalizers, source inventories, or private builds.

Do not replace them with account exports or captured API responses. Add only
the minimum public fixture needed for reproducible coverage and review the
decoded XML for names, URLs, tokens, and other identifying data first.
`npm run check` decodes every text build fixture and rejects account/character
hash fields even when the compressed build code hides them from a text search.
