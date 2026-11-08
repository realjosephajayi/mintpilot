# Security policy

MintPilot holds custodial signing keys. Please report vulnerabilities privately; do not open a public issue.

* Contact: **<add your security contact here>**
* Include: affected component, steps to reproduce, impact.
* We aim to acknowledge reports within 72 hours.

Scope: the bot (`src/bot`), executor and worker (`src/core`, `src/worker.js`), web server (`src/web`),
deployment files. The demo contract (`contracts/ProjectNFT.sol`) is unaudited and for testing only.

Design notes for reviewers: `docs/ARCHITECTURE.md` (threat model), `docs/adr/`, `docs/REVIEW.md`.
