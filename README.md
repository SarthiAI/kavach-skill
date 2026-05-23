# Kavach Skill

The official skills library for [Kavach](https://github.com/SarthiAI/Kavach) execution gates, covering both the Python and Node / TypeScript SDKs.

## What it does

When you ask your coding agent to add Kavach gating, drift detection, signed permit tokens, or default-deny policy enforcement to a service, this skill activates and walks the agent through the correct setup. The skill ships parallel guidance for Python (`kavach-sdk` on PyPI) and Node / TypeScript (`kavach-sdk` on npm), backed by the same Rust core.

## Install

```bash
npx skills add SarthiAI/kavach-skill
```

That places `kavach/` into your project's skills directory. Compatible clients pick it up automatically.

## What's covered

- Installing `kavach-sdk` (PyPI or npm) and constructing a `Gate`.
- Authoring policies as a Python dict, TypeScript object, JSON string, JSON file, TOML string, or TOML file (one schema, five loaders, both languages).
- Wiring the four built-in drift detectors (device, geo, session age, action count) in either binding.
- Issuing signed post-quantum permit tokens with `PqTokenSigner` and verifying them downstream.
- Maintaining a tamper-evident `SignedAuditChain` and exporting it as JSONL.
- Hot-reloading policies and rolling out gradually with observe-only mode.
- Building encrypted + signed + replay-protected byte channels with `SecureChannel`.

## Layout

```
kavach/
├── SKILL.md                  concepts + capabilities + language pointers
├── assets/
│   └── policies.example.toml shared kitchen-sink TOML policy
├── references/
│   └── policy-language.md    shared condition grammar
├── python/                   Python integration: README, sdk, drift, audit, secure-channel, scaffold
└── node/                     Node integration: README, sdk, drift, audit, secure-channel, scaffold
```

The agent reads `SKILL.md` first to understand what Kavach does, then loads `python/README.md` or `node/README.md` depending on the user's stack.

## Scope

This skill covers the published `kavach-sdk` package on PyPI and npm: the `Gate` class (with all five loaders), action context / evaluate options, `Verdict`, `PermitToken`, the four built-in drift detectors, signed permit tokens, the audit chain, the public-key directory, `SecureChannel`, the Python `@guarded` decorator, and the Node MCP middleware `guardTool`. Anything outside that surface is not in scope and the skill should not suggest it. For HTTP / MCP middleware deep dives or multi-replica Redis deployments, see the [Kavach roadmap](https://github.com/SarthiAI/Kavach/blob/main/docs/roadmap.md).

## License

Apache-2.0. The skill content (Markdown, example policies, scaffold scripts) is freely embeddable in any agent runtime. The Kavach library itself is released under [Elastic License 2.0](https://github.com/SarthiAI/Kavach/blob/main/LICENSE); see that repo for terms governing the library.
