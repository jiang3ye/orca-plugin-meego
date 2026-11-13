# Changelog

## 0.1.0-dev.1 — draft companion-host preview

This is an independent community integration, not an official Orca or Feishu Project / Meegle product. The preview requires companion platform changes. CI builds the real Orca CLI from the exact `jiang3ye/orca` source commit pinned in [`.github/orca-sdk.json`](.github/orca-sdk.json). The checked public Orca v1.4.258 still lacks required APIs, including the `location` field rejected by its [strict panel schema](https://github.com/stablyai/orca/blob/v1.4.258/src/shared/plugins/contributions/plugin-panel-contribution.ts). The manifest engine floor is not a public-release compatibility guarantee.

### Added

- Connection removal clears local credentials and advanced configuration after confirmation; disconnect preserves preferences without silently falling back to enterprise access.
- Integration settings link to native plugin management, and development mounts expose their own unload action without deleting source or plugin data.

- Personal Feishu Project OAuth, account discovery and named space selection, with enterprise OpenAPI fallback.
- A connection-only panel in native Settings → Integrations and a sidebar settings shortcut.
- Work-item browsing, title/ID search, typed status filters, comments, template-based creation and positive int64 identity preservation.
- Metadata-driven field, role-member, status and workflow-node operations, with browser fallback for unsupported capabilities.
- Canonical workspace association, durable background workspace creation, receipt recovery and explicit opening.
- Host-scoped installed Agent discovery and action-local new-session selection; existing terminals receive unsubmitted drafts.

### Changed

- Explain work item → code directory → Agent in the detail view, with an explicit workspace picker, project/branch/location/path preview, saved-link state and replacement confirmation.
- Recheck the original account, source and connection generation inside queued association commits and immediately before Agent delivery.
- Preserve the actual Agent terminal receipt and offer an explicit open action; validate workspace membership before focusing without resending the task.
- Keep an explicit handoff open when its selected workspace becomes active; equivalent context refreshes do not discard the first click. Identity, association and deactivation changes still cancel stale handoffs.
- Validate a fixed selected workspace for association and new Agent sessions; an unavailable ambient selection no longer blocks a known target. Existing-terminal drafts retain the active-workspace membership guard.
- Use the upstream official project/host workspace creation API and its dedicated permission; persist ID-only and late receipts before inventory lookup, with explicit association recovery.
- Replaced hand-written Orca SDK mirrors with generated official authoring types.
- Separated workspace actions, item mutations, connection management and presentation responsibilities.
- Added account/source/version and association checks, late-response protection, and explicit recovery for unverified outcomes.
- Commands without an existing Agent now require a choice in the panel instead of launching a hidden default.
- Public documentation and regression fixtures use sanitized business examples.

### CI configuration

- Every push and pull request is configured for three-OS source checks and a complete `npm run check` on macOS 15 Intel, including SDK generation, manifest validation, strict types, offline tests, panel scenarios and source inventory.
- Default CI builds the pinned host source instead of downloading a private full desktop ZIP. It checks canonical declaration/runtime generation with `--check`, runs the official CLI build, and verifies `out/package.json.commit` against the full pinned commit before using the CLI. No hand-written SDK substitutes are used.
- Plugin `v*` tags and manual public-release overrides require a compatible, published official Orca release independently of the default source-built SDK. A companion-fork build cannot satisfy that gate. No verified public release currently meets it.

### Verification and limits

The local verification baseline is 218 passing offline behavior tests and 11 check scenarios. Cloud results are recorded in repository [Actions](https://github.com/jiang3ye/orca-plugin-meego/actions); a successful cloud check is evidenced by the complete SDK job logs for that commit and run. Native fixture evidence includes 20 settings PNGs, 36 core UI PNGs and 20 workspace-flow PNGs. The previously installed companion host preserves encrypted login, exposes its integration settings route, resolves canonical workspace identity and installed Agent choices, reads an existing test item, and reattaches original terminal sessions.

Isolated native Git lifecycle acceptance covers approval, disable/enable, upgrade, actual rollback, uninstall, fresh reinstall and development unload. Connection removal tests cover failed cleanup and late authorization without touching a live account.

Earlier authorized business checks and isolated Codex delivery are segmented evidence. The isolated macOS Electron/CDP journey now covers the real Meego UI and worker through native workspace creation, explicit Agent selection, terminal opening and the submitted prompt visible in the actual PTY, then connection removal. HTTP provider responses and the model TUI use declared synthetic fixtures; no host APIs are mocked. A separate public host regression covers native integration discovery and development unload. This is not evidence of a current external model response or non-macOS/remote live acceptance. International and enterprise connections have not completed live business acceptance.

See the [README](README.md#验证范围), [development guide](docs/development.md) and [release guide](docs/releasing.md) for current scope and release requirements.
