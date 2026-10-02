# Build transfer contract v1

Raw build codes stay browser-local. Saved builds resolve only from canonical
HTTPS `pob.codes/b/<token>` links through the configured owned API base
(`https://pob.codes/api` or `https://api.pob.codes`) as the capability gate;
the exact resolution request is `GET https://api.pob.codes/<token>/raw` and
returns the raw code as text. Arbitrary source URLs,
redirects, credentials, and non-owned API origins are refused.

Sharing is user-triggered and sends the current same-instance export to
`POST <owned-api-base>/pob` with the raw code as text. HTTP 201 must return
`{ id, shortUrl }`, a canonical `/b/<token>` short URL, and `Cache-Control:
no-store`. A failed request retains that exact exported
snapshot; retry does not re-export potentially changed editor state. Responses
must produce a canonical `https://pob.codes/b/<token>` link. Requests time out,
codes are size-bounded, and the feature stays unavailable when the public API
origin is not configured.
