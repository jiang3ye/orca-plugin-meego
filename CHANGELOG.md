# Changelog

## 0.1.0-dev.1 — draft companion-host preview

This preview requires the custom Orca companion platform introduced at commit `9df199ef`. The CI SDK uses a descendant with the generated SDK/runtime synchronization fix; its exact commit, ZIP SHA256 and CLI version are pinned in [`.github/orca-sdk.json`](.github/orca-sdk.json). Public Orca 1.4.256 and public main do not yet include the required APIs. The manifest engine floor is not a public-release compatibility guarantee.

### Added

- Personal Feishu Project OAuth, account discovery and named space selection, with enterprise OpenAPI fallback.
- A connection-only panel in native Settings → Integrations and a sidebar settings shortcut.
- Work-item browsing, title/ID search, typed status filters, comments, template-based creation and positive int64 identity preservation.
- Metadata-driven field, role-member, status and workflow-node operations, with browser fallback for unsupported capabilities.
- Canonical workspace association, durable background workspace creation, receipt recovery and explicit opening.
- Host-scoped installed Agent discovery and action-local new-session selection; existing terminals receive unsubmitted drafts.

### Changed

- Replaced hand-written Orca SDK mirrors with generated official authoring types.
- Separated workspace actions, item mutations, connection management and presentation responsibilities.
- Added account/source/version and association checks, late-response protection, and explicit recovery for unverified outcomes.
- Commands without an existing Agent now require a choice in the panel instead of launching a hidden default.
- Public documentation and regression fixtures use sanitized business examples.

### CI configuration

- Every push and pull request is configured for three-OS source checks and a complete `npm run check` on macOS 15 ARM64, including SDK generation, manifest validation, strict types, offline tests, panel scenarios and source inventory.
- Default CI uses a SHA256-pinned private companion SDK prerelease named `ci-host-<commit12>`, with the host commit and CLI version recorded in the pin file. It is not a plugin version release or an official Orca `latest` build.
- Plugin `v*` tags and manual public-release overrides require a compatible, published official Orca release independently of default companion-SDK CI. No verified public release currently meets that gate.

### Verification and limits

The local verification baseline is 185 passing offline behavior tests and 11 check scenarios. Cloud results are recorded in repository [Actions](https://github.com/jiang3ye/orca-plugin-meego/actions); a successful cloud check is evidenced by the complete SDK job logs for that commit and run. Native fixture evidence includes 20 settings PNGs and 36 core UI PNGs. The installed companion host preserves encrypted login, exposes its integration settings route, resolves canonical workspace identity and installed Agent choices, reads an existing test item, and reattaches original terminal sessions.

Earlier authorized business checks and isolated Codex delivery are segmented evidence. A new Agent has not yet been retested through the current installed build's complete flow. Full rendered GUI acceptance remains open because the mandated Electron skill is unavailable. International and enterprise connections have not completed live business acceptance.

See the [README](README.md#验证范围), [development guide](docs/development.md) and [release guide](docs/releasing.md) for current scope and release requirements.
