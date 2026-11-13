# Contributing

This project is an experimental Meego integration for a companion Orca host. The checked public Orca 1.4.258 does not include all required platform APIs. Start with the [development guide](docs/development.md) and the [architecture](docs/architecture.md); use the companion host and matching CLI, not a public release selected only by version number.

## Prepare a change

Describe the user-visible problem, a concrete trigger and the expected result. Keep provider adaptation, worker scope checks and native presentation in their owning modules. New provider integrations need an explicit design and their own capability tests; Jira and Linear are not currently implemented.

Use Orca's native component catalog and semantic theme tokens. Keep connection management in Settings, Agent selection next to the handoff action, and implementation details out of normal product flows.

Preserve account, source, version, workspace and association checks. Capture the displayed target before asynchronous work; discard late results after a scope change. Do not turn an unverified write into an automatic retry or treat a successful launch request as completed Agent delivery.

## Check a change

Use Node.js 24 or later and the CLI from the matching companion build:

```sh
npm ci
npm run check:development
```

`check:development` generates official SDK types before validating the manifest, typechecking, testing, rendering panel scenarios and checking the source allowlist. Development validation explicitly allows unreleased fields while retaining all numbered engine floors. Default `check`, release preparation and catalog validation stay strict until the host maintainers assign the first supporting release. Orca supplies the CLI; do not install the unrelated npm package named `orca`.

`.orca/types` is generated and ignored. Do not commit it, edit it or introduce another hand-written Orca API mirror. Keep `src/protocol.ts` as the shared request/event contract.

Add regressions for changed behavior at its owning boundary. Prefer exact expected business payloads, stale-response scenarios and outcome checks. Do not test private atoms, copy, CSS classes or implementation counts. Ordinary tests and render checks must stay offline. They must not create items, post comments, change members or mutate workflows in a real tenant.

Include the commands run, results and any relevant verification gap in the pull request. Native fixture renders help assess layout, but they do not replace the prescribed GUI acceptance workflow. Do not claim an unavailable Electron-skill check passed.

## Protect project and user data

Use synthetic names, accounts, spaces, item IDs, request markers and URLs in fixtures. Keep provider envelope shapes and failure cases when replacing captured values. Preserve exact int64 boundary examples and hardcoded scope assertions.

Do not attach raw tenant responses, account identifiers, real work-item links, customer screenshots, local profiles, terminal identities, credentials or tokens. A value does not become publishable merely because it is not a password. Public examples should be independently understandable without a local acceptance ledger.

Private acceptance records and generated files belong in ignored `.orca/`; local screenshots belong in ignored `artifacts/`. A live acceptance run requires a separately authorized, bounded scope and a durable record. Never clear a user's profile, stop unrelated terminals or overwrite existing workspace links to obtain a passing result.

## Release and history

See the [release guide](docs/releasing.md) for release ownership, packaging and compatibility gates. A contribution does not authorize publishing, pushing tags or changing remotes.

The initial public repository must be created from a reviewed, sanitized source snapshot. Do not publish local development history containing private captures or acceptance notes. Removing a file in a later commit does not remove its earlier contents from Git history.
