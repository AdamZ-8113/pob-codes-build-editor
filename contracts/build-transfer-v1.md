# Build transfer contract v1

Raw build codes stay browser-local. Canonical `pob.codes/b/<token>` links read
the raw code from `GET https://api.pob.codes/<token>/raw`. Other link inputs are
sent to the existing `POST https://api.pob.codes/pob` resolver, which owns the
same bounded host allowlist used by the `/b/` importer: Maxroll, pobb.in,
pob.codes, poe.ninja, Pastebin, and PoEDB. The editor then reads the resolved
raw code by its returned build ID. Arbitrary client-side proxy targets,
credentials, and redirects are not accepted by the editor.

The single `Launch in PoB.Codes` action exports the displayed build, uploads it
to the same `POST https://api.pob.codes/pob/plain` endpoint used by PoB's native
`pob.codes` sharing-site entry, and opens the resulting canonical
`https://pob.codes/b/<token>` viewer. Browser writes carry the API's required
`x-pobcodes-client: web` header. A failed request retains that exact exported
snapshot; retry does not re-export potentially changed editor state. Requests
time out after 12 seconds, including response-body consumption. Raw codes are
limited to 8 MiB, resolver envelopes to 64 KiB, and sharing responses to 4 KiB;
limits count streamed bytes and cancel oversized responses. Codes accept native
Base64url exports with optional trailing padding, preserving the exact snapshot.

Native PoB build-site downloads are routed through that same resolver, and its
native `pob.codes` upload is allowed only to `/pob/plain`. Other native network
requests still fail closed; this contract is not a general CORS proxy.
