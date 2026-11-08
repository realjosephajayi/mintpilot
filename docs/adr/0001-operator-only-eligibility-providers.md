# 0001. Eligibility data comes only from operator-configured providers
Date: 2026-11-04 · Status: Accepted · Review finding: #1

## Context
Adapter JSON typed by any Telegram user accepted `proofFile`, `signatureFile`, `proofUrl` and
`signatureUrl`. The server read arbitrary files (the first bytes leaked in error messages; `/dev/zero`
crashed the single bot/web/worker process) and fetched arbitrary URLs, including plain-HTTP localhost in
production and redirects to internal hosts.

## Decision
* Users may only type the keys each adapter documents (`USER_KEYS` in `mintAdapters.js`); everything else is
  rejected. File/URL keys are additionally rejected in `resolveMintSpec`, which also protects stored specs.
* Merkle proofs, mint signatures and SeaDrop server signatures come from providers listed in
  `ELIGIBILITY_PROVIDERS_JSON` (`kind`, HTTPS `url`, `method`, secret `headers`, optional `chain`/`contract`),
  referenced by `providerId`. `SEADROP_SIGNATURE_PROVIDERS_JSON` remains as a legacy alias.
* Provider fetches: HTTPS only (HTTP to localhost outside production), `redirect: 'error'`, 64 KB cap, 5 s
  timeout; answers must match the wallet/contract/chain/quantity; errors shown to users never include the
  URL, headers or body. 429/5xx/network = retry, other 4xx = terminal.

## Consequences
+ No file read or SSRF primitive from chat; one place to audit provider traffic.
− Projects that publish proofs only as files need the operator to host them behind HTTPS.
− Inline proofs/signatures are bound to one wallet; the wizard enforces a single wallet for them.
