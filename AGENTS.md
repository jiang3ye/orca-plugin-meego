# Development

This is an Orca trusted-worker plugin. TS/TSX source loads directly; npm is development tooling, not a plugin build or publication format.

- Read `docs/architecture.md` for ownership and `docs/development.md` for the SDK workflow.
- Use a compatible Orca CLI and generate `.orca/types` with `npm run sdk`. Do not write or commit replacement Orca SDK declarations.
- Run `npm run check` after behavior changes. Add behavioral regressions at the owning layer; avoid copy, styling, timing, and private-state tests.
- Use Orca declarative components and their spacing, tone, and size tokens. Panels have no DOM, network, React hooks, or arbitrary CSS.
- Worker requests own authentication and all side effects. Preserve account, region, space, work-item, revision, and workspace identity checks.
- Never automatically resend an uncertain write or repeat an uncertain workspace creation. An accepted launch is not proof that an Agent received its prompt.
- New Agent sessions require an explicit choice from the target host's installed and enabled catalog. Existing terminals receive drafts without Enter.
- Keep credentials, customer data, SDK caches, local evidence, and screenshots out of Git. Use synthetic fixtures and a separate, explicitly authorized space for live writes.
- Do not modify existing business work items during verification. Do not show or focus automated desktop windows.
- Follow `docs/releasing.md` before release work. The manifest's numeric engine floor does not prove that a public Orca release includes the companion host APIs.
