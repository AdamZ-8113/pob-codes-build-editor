# Character host contract v1

The browser host recognizes only HTTPS requests to `pathofexile.com` for
`character-window/get-characters`, `get-items`, and `get-passive-skills`.
After a successful list, PoB's `account/view-profile/<account>` follow-up is
answered locally with the active account's encoded profile link. It does not
fetch profile HTML or discover canonical account-name casing; account handling
remains with the guarded API. Other accounts, profile subpaths, and requests
after reset are refused. Everything else is refused; this is not a general proxy.

Realms are normalized to `pc`, `xbox`, or `sony`. Account and character inputs
are required, bounded to 64 characters, and reject controls and angle brackets.
Requests are bounded to 2 KiB URLs and 4 KiB bodies, responses to 16 MiB, two
concurrent core requests, and 12 seconds. A new character-list request starts a
generation: older results are stale and discarded. Reset cancels the logical
generation; timeouts use `AbortSignal`. Item and passive requests for the same
generation/account/character share one `/api/poe/import-character` request.
Failed requests and invalid envelopes are evicted so retry starts a fresh
request. A cached pair expires after 12 seconds, checked before reuse, or once
both item and passive operations have consumed it. Production response bodies
are bounded while streaming, and the deadline remains active through body
consumption.

The core API uses POST JSON envelopes with `contractVersion: 1`. Successful
responses are `{ "ok": true, "data": ... }`; errors are
`{ "ok": false, "error": { "code": "...", "message": "..." } }`.
Production translates the envelopes to the existing same-origin PoB Codes
`/api/poe/characters` and `/api/poe/import-character` routes. The transport sends
no credentials, rejects alternate origins and operations, and preserves the
guarded API's public error messages. Contributor mock mode may use the checked
fixtures. The user-facing fallback is build-code paste or file import.

OAuth is not a v1 capability. This is a browser callback limitation, not a need
to register another GGG application: Path of Building's existing `pob` client
redirects to a loopback listener that the static browser host cannot provide.
Hosts refuse those callbacks, and the checked PoB source adaptation hides the
OAuth controls while retaining public-account and code/file import controls.
