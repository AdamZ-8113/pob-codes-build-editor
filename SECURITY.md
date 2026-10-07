# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub: open the
repository's Security tab and choose "Report a vulnerability", or go directly to
<https://github.com/AdamZ-8113/pob-codes-build-editor/security/advisories/new>.

Do not open public issues, pull requests, or discussions for vulnerabilities.

## Supported versions

Fixes are made for the live deployment at <https://pob.codes/import2/> and the
latest `main`. Older releases are not patched.

## Scope

In scope for this repository:

- the editor shell (`index.html`, `src/`)
- the bundled browser runtime and driver (`upstream/`)
- the local dev server and LAN HTTPS tooling (`scripts/dev/`)
- build and release scripts (`scripts/`)
- CI workflows (`.github/workflows/`)

Character import and build sharing use the PoB Codes API at api.pob.codes, which
is not part of this repository. Issues in other PoB Codes services (pob.codes,
api.pob.codes) can be reported through the same private channel. Production
deployment is handled by a separate private workflow; this repository holds no
production credentials.

This project is a fork of [atty303/pob-web](https://github.com/atty303/pob-web)
and runs code from
[Path of Building](https://github.com/PathOfBuildingCommunity/PathOfBuilding).
Calculation bugs and other non-security issues in Path of Building belong
upstream at PathOfBuildingCommunity/PathOfBuilding, and runtime issues that are
not specific to this fork belong at atty303/pob-web, both as normal issues.
Report security issues in either project privately to that project; if one also
affects pob.codes/import2, you can report it here as well.

## What to include

- the affected URL or commit
- steps to reproduce
- the impact you expect

## Testing guidelines

- Do not access or modify other users' data or builds.
- Do not run load or denial-of-service tests against pob.codes or api.pob.codes.
- Use your own accounts and test builds.

## Response

This is a volunteer-maintained project. Reports are handled on a best-effort
basis, with no guaranteed response times and no bug bounty.
