# Kavach Skill

The official skills library for [Kavach](https://github.com/SarthiAI/Kavach) execution gates to a Python application.

## What it does

When you ask your coding agent to add Kavach gating, drift detection, signed permit tokens, or default-deny policy enforcement to a Python service, this skill activates and walks the agent through the correct setup using the published `kavach-sdk` package on PyPI.

## Install

```bash
npx skills add SarthiAI/kavach-skill
```

That places `kavach/` into your project's skills directory. Compatible clients pick it up automatically.

## What's covered

- Installing `kavach-sdk` and constructing a `Gate`.
- Authoring policies as a Python dict, JSON string, JSON file, TOML string, or TOML file (one schema, five loaders).
- Wiring the four built-in drift detectors (device, geo, session age, action count).
- Issuing signed post-quantum permit tokens with `PqTokenSigner` and verifying them downstream.
- Maintaining a tamper-evident `SignedAuditChain` and exporting it as JSONL.
- Hot-reloading policies and rolling out gradually with observe-only mode.

## Scope

This skill covers the published `kavach-sdk` package on PyPI: the Python `Gate` (with all five loaders), `ActionContext`, `Verdict`, `PermitToken`, the four built-in drift detectors, signed permit tokens, the audit chain, the public-key directory, `SecureChannel`, and the `@guarded` decorator. Anything outside that surface is not in scope and the skill should not suggest it. For surfaces that are not yet released (Node SDK, HTTP / MCP middleware, multi-replica Redis deployments), see the [Kavach roadmap](https://github.com/SarthiAI/Kavach/blob/main/docs/roadmap.md).

## License

Apache-2.0. The skill content (Markdown, example policies, scaffold scripts) is freely embeddable in any agent runtime. The Kavach library itself is released under [Elastic License 2.0](https://github.com/SarthiAI/Kavach/blob/main/LICENSE); see that repo for terms governing the library.