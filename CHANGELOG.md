# Changelog

## 0.1.0-dev.1 — draft companion-host preview

This preview requires the custom Orca companion host at commit `9df199ef`, which includes the integration platform changes. Public Orca 1.4.256 and public main do not yet include the required APIs. The manifest engine floor is not a public-release compatibility guarantee.

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

### Verification and limits

Verification records show 185 offline behavior tests and 11 check scenarios pass. Native fixture evidence includes 20 settings PNGs and 36 core UI PNGs. The installed companion host preserves encrypted login, exposes its integration settings route, resolves canonical workspace identity and installed Agent choices, reads an existing test item, and reattaches original terminal sessions.

Earlier authorized business checks and isolated Codex delivery are segmented evidence. A new Agent has not yet been retested through the current installed build's complete flow. Full rendered GUI acceptance remains open because the mandated Electron skill is unavailable. International and enterprise connections have not completed live business acceptance.

See the [README](README.md#验证范围), [development guide](docs/development.md) and [release guide](docs/releasing.md) for current scope and release requirements.
