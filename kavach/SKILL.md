---
name: kavach
description: Add a default-deny execution gate around AI-agent actions in Python or Node / TypeScript using the kavach-sdk library. Use when the user is integrating Kavach, wants to add policy enforcement, drift detection, signed permit tokens, signed audit chains, secure channels, or default-deny request validation, mentions Gate, Guarded, PermitToken, ActionContext, EvaluateOptions, McpKavachMiddleware, guardTool, or wants to wrap LangChain, LangGraph, MCP tool calls, Express, Fastify, or any agent tool-call code behind a deny-by-default check. Skip if Kavach is already wired up and the user is debugging unrelated code, or if the user is asking about a different policy engine (OPA, Cerbos, Casbin).
license: Apache-2.0
compatibility: Python 3.10 or newer with `kavach-sdk` from PyPI. Node 18 or newer with `kavach-sdk` from npm. Both bindings sit on top of the same Rust core; behaviour, policy schema, verdict shape, and crypto primitives are identical across languages.
metadata:
  homepage: https://github.com/SarthiAI/Kavach
  pypi: kavach-sdk
  npm: kavach-sdk
  version: "0.1.0"
---

# Kavach: default-deny execution gates for AI agents

> **Next step, pick your language and load that doc immediately:**
> - **Python**: read [python/README.md](python/README.md), then [python/sdk.md](python/sdk.md).
> - **Node / TypeScript**: read [node/README.md](node/README.md), then [node/sdk.md](node/sdk.md).
>
> The rest of this file is the conceptual overview. Code, install commands, and full API surface live in the language folder you just picked.

Kavach is a Rust-core library, bound to both Python and Node / TypeScript, that puts a deny-by-default gate in front of every action an agent or service tries to execute. Both bindings ship the same surface: a policy gate, four built-in drift detectors, post-quantum signed permit tokens, a tamper-evident audit chain, and a secure channel primitive. The behaviour is identical across languages because every cryptographic primitive and every evaluator runs in the same compiled Rust core.

## What it does

Every call passes through three evaluators in order:

1. **Policy** decides whether the action matches a permit rule. Identity checks (`identity_kind`, `identity_role`, `identity_id`) run inside this phase. No matching permit means Refuse.
2. **Drift** (optional, on by default) checks four signals about the principal's runtime context: device fingerprint, geo / IP, session age, and action-rate. Any violation can Refuse or Invalidate.
3. **Invariants** (optional, present when configured) enforce hard numeric caps that beat any permissive policy. A policy permit that crosses an invariant becomes a Refuse.

Each call produces exactly one of three verdicts:

- **Permit**, with a signed `PermitToken` you can hand to downstream services as proof the action passed the gate.
- **Refuse**, with an evaluator name and a reason code so the calling code knows *why* it was blocked.
- **Invalidate**, which kills the entire session (used by drift detectors when something looks compromised).

Every error path fails closed. Missing parameters, unparseable durations, store outages, broadcaster failures, signer errors, and unverifiable tokens all collapse to Refuse rather than vacuously permit.

## When this skill applies

Activate this skill when the user is doing any of the following in either Python or Node / TypeScript:

- Adding `kavach-sdk` to a service.
- Wrapping a LangChain tool, LangGraph node, MCP tool-call handler, Express / Fastify route, or any agent tool-call function behind a `Gate.evaluate(...)` / `Gate.check(...)` call.
- Authoring a Kavach policy (Python dict, TypeScript object, JSON, or TOML form).
- Wiring drift detectors (device fingerprint, geo location, session age, action count).
- Issuing or verifying signed `PermitToken`s with `PqTokenSigner`.
- Maintaining a tamper-evident `SignedAuditChain` of agent actions.
- Building a `SecureChannel` between two services.
- Asking how `Gate`, `ActionContext` (Python) / `EvaluateOptions` (Node), `Verdict`, `Guarded`, or `guardTool` work.

Skip when the user is asking about a different policy engine, building a different library, or already has Kavach wired and is debugging an unrelated issue.

## Capabilities at a glance

| Capability                                                | Surface                                                  | Demonstrated in                                                                                              |
| --------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Default-deny policy gate                                  | `Gate.evaluate` / `Gate.check`                           | scenario 01 (quickstart), 02 (document access), 08 (loan approval)                                            |
| Five policy loaders (TOML, TOML file, dict / object, JSON, JSON file) | `Gate.from_dict`, `Gate.fromObject`, etc.       | scenario 23 (format equivalence in the older suite); every scenario uses one of the five                      |
| Four drift detectors (device, geo, session age, action count) | drift evaluator, `EvaluateOptions` fields            | scenario 03 (geo drift), 04 (session hygiene), 11 (e-commerce fraud)                                          |
| Tolerant-mode geo drift with distance threshold           | `geo_drift_max_km` / `geoDriftMaxKm`                     | scenario 03 (password reset across geo)                                                                       |
| Hard-cap invariants beating any permissive policy         | `invariants=[...]` constructor arg                       | scenario 08 (loan approval regulator cap), 11 (e-commerce fraud cap)                                          |
| Hot reload + empty-policy kill switch                     | `gate.reload(toml)`                                      | scenario 19 (hot reload resilience in the older suite)                                                        |
| Observe-only rollout                                      | `observe_only=True` / `observeOnly: true`                | scenario 11 (e-commerce fraud rollout)                                                                        |
| PQ-signed permit tokens (ML-DSA-65, hybrid Ed25519)       | `PqTokenSigner`, `verdict.permit_token`                  | scenario 05 (signed permit), 06 (ephemeral permits), 09 (key rotation)                                        |
| Hybrid-mode downgrade defence                             | `is_hybrid` / `isHybrid` enforcement                     | scenario 07 (PQ hybrid downgrade)                                                                             |
| Tamper-evident signed audit chain with JSONL export       | `SignedAuditChain`, `AuditEntry`                         | scenario 10 (break glass), 16 (healthcare PHI), 17 (PQ audit rotation), 20 (AI underwriter evidence)         |
| Public-key directory + root-signed manifest               | `PublicKeyDirectory.from_signed_file` / `.fromSignedFile`, `DirectoryTokenVerifier` | scenario 09 (key rotation), 15 (agent marketplace), 17 (audit rotation)                  |
| Cross-replica invalidation broadcast                      | `InMemoryInvalidationBroadcaster`, `spawn_invalidation_listener` | scenario 03 (geo drift broadcast), 14 (invalidation fanout)                                          |
| Encrypted + signed + replay-protected byte channel        | `SecureChannel`                                          | scenario 13 (secure channel fleet), 15 (agent marketplace), 21 (customer deployed agent)                      |
| AI-agent attestation (prompt-injection defence)           | signed intent + scope-hash binding                       | scenario 18 (AI agent attestation), 19 (cross-SaaS finance agent), 20 (AI underwriter), 21 (customer deployed) |
| MCP tool-call gating middleware                           | `McpKavachMiddleware.guardTool` / `checkToolCall` (Node) | scenario 12 (HTTP + MCP middleware)                                                                           |

Scenario numbers refer to the runnable suites at [business-tests-python](https://github.com/SarthiAI/Kavach/tree/main/business-tests-python) (Python, 21 scripts) and [business-tests-node](https://github.com/SarthiAI/Kavach/tree/main/business-tests-node) (Node, 21 scripts mirroring Python one-to-one).

## Policy schema overview

One schema, five loaders, both languages:

```toml
[[policy]]
name = "agent_small_refunds"
effect = "permit"
priority = 10
conditions = [
    { identity_kind = "agent" },
    { action = "issue_refund" },
    { param_max = { field = "amount", max = 5000.0 } },
]
```

Same vocabulary in a Python dict or a TypeScript object. The condition variants (`identity_kind`, `identity_role`, `identity_id`, `action`, `resource`, `param_max`, `param_min`, `param_in`, `rate_limit`, `session_age_max`, `time_window`) are identical across all formats. Misspelled condition names are rejected at load time in every loader, in every language.

For the full grammar (conditions, durations, time-window syntax, priority order, default-deny semantics, hot-reload behaviour), read [references/policy-language.md](references/policy-language.md).

## Pick your language

| Language          | Entry point                          | When                                                   |
| ----------------- | ------------------------------------ | ------------------------------------------------------ |
| Python 3.10+      | [python/README.md](python/README.md) | Backend service in Python, FastAPI / Django / Flask, LangChain / LangGraph orchestration, Jupyter / data pipelines. |
| Node / TypeScript | [node/README.md](node/README.md)     | Backend service in Node, Express / Fastify, MCP server, agent runtime, Edge functions, anything in the npm ecosystem. |

Each language folder ships the same five deep-reference docs: `README.md` (install + quickstart), `sdk.md` (full surface), `drift-detectors.md`, `audit-and-pq.md`, `secure-channel.md`, plus a runnable scaffold (`scaffold.py` / `scaffold.ts`).

Shared across both languages: [references/policy-language.md](references/policy-language.md) (policy grammar) and [assets/policies.example.toml](assets/policies.example.toml) (kitchen-sink TOML example).

## Hard rules (apply to every language)

- **Never fail open.** Do not change `Gate` to skip evaluators, return Permit on errors, or downgrade Refuse to Permit. The library's contract is fail-closed; integrators rely on it for compliance and incident response.
- **Never skip invariants when refactoring policies.** Invariants are the regulator-grade hard floor that beats any permissive policy. Removing them in favour of a `param_max` policy condition silently weakens the system.
- **No implicit allow.** An empty policy set is valid and means deny-everything (useful as a kill switch). To permit anything, write a policy with `effect: "permit"` and the conditions that match.
- **Do not install third-party crypto libraries to handle Kavach signatures.** The SDK ships every algorithm Kavach uses (ML-DSA-65, ML-KEM-768, Ed25519, X25519, ChaCha20-Poly1305) compiled in via PyO3 (Python) and napi-rs (Node). External PQ libraries are not guaranteed interoperable.
- **Sign-failure is fail-closed.** A `PqTokenSigner` that errors during evaluation turns the verdict into Refuse, never a permit-without-signature.
- **Always pass UUIDs for `session_id` / `sessionId`.** A non-UUID value is silently replaced with a fresh random UUID, which means rate-limit and drift state will not match between calls that share a non-UUID string.

## Verifying a working integration

A successful integration produces a Permit verdict carrying a fresh `tokenId` for in-policy actions, and a Refuse / Invalidate verdict (with the right `evaluator` and `code`) for out-of-policy actions. Both languages ship 21 runnable scenarios that pin the full contract end-to-end:

- Python: [github.com/SarthiAI/Kavach/tree/main/business-tests-python](https://github.com/SarthiAI/Kavach/tree/main/business-tests-python)
- Node: [github.com/SarthiAI/Kavach/tree/main/business-tests-node](https://github.com/SarthiAI/Kavach/tree/main/business-tests-node)

Each suite runs in roughly twelve to thirteen seconds and exits 0 on full pass.

## Next step (again, do not skip)

> **Load the language doc for the user's stack now.** This SKILL.md is overview only; it does not contain install commands, working code, or the full API surface.
> - **Python**: [python/README.md](python/README.md) and [python/sdk.md](python/sdk.md).
> - **Node / TypeScript**: [node/README.md](node/README.md) and [node/sdk.md](node/sdk.md).
> - Shared by both: [references/policy-language.md](references/policy-language.md), [assets/policies.example.toml](assets/policies.example.toml).

## License + repo

Kavach the library is released under the [Elastic License 2.0](https://github.com/SarthiAI/Kavach/blob/main/LICENSE) (source-available; embed and modify, but do not repackage as a competing hosted service). This skill content (Markdown, example policies, scaffold scripts) is Apache-2.0 and freely embeddable in any agent runtime.

For surfaces not yet covered in this skill (HTTP middleware deep dive, multi-replica Redis deployments, additional language bindings), see the [Kavach roadmap](https://github.com/SarthiAI/Kavach/blob/main/docs/roadmap.md).
