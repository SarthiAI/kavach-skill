---
name: kavach
description: Add a default-deny execution gate around AI-agent actions in Python using the kavach-sdk library. Use when the user is integrating Kavach, wants to add policy enforcement, drift detection, signed permit tokens, or default-deny request validation, mentions Gate, Guarded, PermitToken, ActionContext, or wants to wrap LangChain, LangGraph, MCP, or any tool-calling code behind a deny-by-default check. Skip if Kavach is already wired up and the user is debugging unrelated code, or if the user is asking about a different policy engine (OPA, Cerbos, Casbin).
license: Apache-2.0
compatibility: Python 3.10 or newer with kavach-sdk installed from PyPI. The Node SDK exists in the upstream repo but is not yet published to npm; treat Node integration as out of scope for this skill.
metadata:
  homepage: https://github.com/SarthiAI/Kavach
  pypi: kavach-sdk
  version: "0.1.0"
---

# Kavach: default-deny execution gates for AI agents

Kavach is a Rust-core, Python-bound library that puts a deny-by-default gate in front of every action your agent or service tries to execute. The gate runs four evaluators in order (identity, policy, drift, invariants) and produces one of three verdicts:

- **Permit** with a signed `PermitToken` you can hand to downstream services as proof the action passed the gate.
- **Refuse** with an evaluator name and a reason code, so the calling code knows *why* it was blocked.
- **Invalidate** to nuke an entire session (used by drift detectors when something looks compromised).

Every error path fails closed. Missing parameters, unparseable durations, store outages, and broadcaster failures all collapse to Refuse rather than vacuously permit.

## When this skill applies

Activate this skill when the user is doing any of the following:

- Adding `kavach-sdk` to a Python project.
- Wrapping a LangChain tool, LangGraph node, or MCP tool call behind a `Gate.evaluate(...)` check.
- Authoring a Kavach policy (in Python dict, JSON, or TOML form).
- Wiring drift detectors (device fingerprint, geo location, session age, action count).
- Issuing or verifying signed `PermitToken`s with `PqTokenSigner`.
- Maintaining a tamper-evident `SignedAuditChain` of agent actions.
- Asking how `Gate`, `ActionContext`, `Verdict`, or `Guarded` work.

Skip when the user is asking about a different policy engine, building a different library, or already has Kavach wired and is debugging an unrelated issue.

## What to install and import

```bash
pip install kavach-sdk
```

The package is published as `kavach-sdk` on PyPI, but the import name is `kavach`:

```python
from kavach import Gate, ActionContext
```

A single `abi3` wheel per platform covers CPython 3.10, 3.11, 3.12, and every future Python.

## The shortest working example

```python
from kavach import ActionContext, Gate

policy = {
    "policies": [
        {
            "name": "agent_small_refunds",
            "effect": "permit",
            "conditions": [
                {"identity_kind": "agent"},
                {"action": "issue_refund"},
                {"param_max": {"field": "amount", "max": 1000.0}},
            ],
        },
    ],
}

gate = Gate.from_dict(
    policy,
    invariants=[("hard_cap", "amount", 50_000.0)],
)

ctx = ActionContext(
    principal_id="agent-bot",
    principal_kind="agent",
    action_name="issue_refund",
    params={"amount": 500.0},
)

verdict = gate.evaluate(ctx)
if verdict.is_permit:
    print("permit", verdict.token_id)
else:
    print(f"blocked: [{verdict.code}] {verdict.evaluator}: {verdict.reason}")
```

A few load-bearing details to communicate to the user:

- **No matching permit means Refuse.** There is no implicit allow. An empty policy set is valid (it denies everything, useful as a kill switch via hot reload).
- **Invariants beat policies.** The third tuple element in `invariants=[...]` is a hard cap on a numeric param. Even a permit verdict from the policy phase gets overturned by a violating invariant.
- **Typo'd condition names raise.** `{"idnetity_kind": "agent"}` raises `ValueError` instead of being silently ignored. This is true for `from_dict`, `from_toml`, and the JSON loaders alike.

## Loading policies, the four ways

```python
gate = Gate.from_dict(policy_dict)          # native Python dict, recommended for programmatic policy
gate = Gate.from_json_string(json_string)   # JSON over the wire (REST API, ConfigMap)
gate = Gate.from_json_file("kavach.json")   # JSON file on disk
gate = Gate.from_toml(toml_string)          # operator-edited TOML
gate = Gate.from_file("kavach.toml")        # TOML file on disk
```

All five produce an identical `Gate` and identical evaluation. Pick by where the policy lives, not by what it does. Hand-edited config in git: TOML. Programmatic construction from Python: dict. JSON over the wire: JSON. The condition vocabulary, defaults, and fail-closed semantics are the same.

For the full grammar of conditions, priorities, durations, and time-window syntax, read [references/policy-language.md](references/policy-language.md).

## ActionContext fields you actually need

| Field             | Required for                                   | Notes                                                         |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `principal_id`    | always                                         | Stable string. Used as the rate-limit bucket prefix.          |
| `principal_kind`  | always                                         | One of `"user"`, `"agent"`, `"service"`, `"scheduler"`, `"external"`. |
| `action_name`     | always                                         | Used by the `action` condition. Wildcards via trailing `*`.   |
| `params`          | numeric guards (`param_max`, `param_min`, `param_in`), invariants | Plain dict. Numbers stay numeric; strings stay strings.       |
| `roles`           | `identity_role` conditions                     | List of strings. Order does not matter.                       |
| `resource`        | `resource` conditions                          | Optional. Missing resource fails the condition (closed).      |
| `session_id`      | `session_age_max`, `action_count` drift        | Stable string per session.                                    |
| `session_started_at` | `session_age_max` drift                     | UTC datetime. Required when using session-age drift.          |
| `action_count`    | `action_count` drift detector                  | Integer. Caller increments per action.                        |
| `ip`, `current_geo`, `origin_geo` | geo drift detector              | See [references/drift-detectors.md](references/drift-detectors.md). |
| `device`, `origin_device` | device drift detector                  | `DeviceFingerprint` instance. See drift-detectors doc.        |

Anything you do not pass is simply not evaluated. Drift conditions that need a missing field fail closed, never silently bypass.

## The `@guarded` decorator

For tool-call wrappers, prefer the decorator over manually building the context:

```python
from kavach import guarded

@guarded(gate, action="issue_refund", param_fields={"amount": "amount"})
async def issue_refund(order_id: str, amount: float):
    return {"status": "refunded", "order_id": order_id, "amount": amount}

result = await issue_refund(
    "ORD-123", 500.0,
    _principal_id="bot", _principal_kind="agent",
)
```

Both async and sync wrapped functions are supported. Only numeric parameters are forwarded to the gate (the policy and invariant evaluators care about numeric thresholds, nothing else).

## Hot reload and the empty-policy kill switch

```python
gate.reload(new_policy_toml)
```

`reload` accepts a TOML string. It raises `ValueError` on parse error and leaves the previous good set untouched. Reloading with `""` (empty TOML) installs an empty PolicySet, which means *deny everything*. That is the recommended kill switch for "stop all agent actions, now" and the safest possible default state.

## Observe-only rollout

To stage Kavach without blocking traffic, construct the gate with `observe_only=True`:

```python
gate = Gate.from_dict(policy, observe_only=True)
```

The verdict shape is identical, but `verdict.is_permit` is `True` for everything. Read `verdict.would_have_been` (Permit / Refuse / Invalidate) to log what the real gate would have done. Flip `observe_only=False` when the logs look right.

## Deeper reference

- [references/python-sdk.md](references/python-sdk.md): full Python surface, including the `@guarded` decorator, hot reload, and observe-only mode.
- [references/policy-language.md](references/policy-language.md): condition vocabulary, duration syntax, time-window grammar, kitchen-sink example.
- [references/drift-detectors.md](references/drift-detectors.md): device, geo, session-age, action-count detectors and their `ActionContext` fields.
- [references/audit-and-pq.md](references/audit-and-pq.md): `KavachKeyPair`, `PqTokenSigner` (PQ-only and hybrid), `SignedAuditChain`, JSONL export and verification.
- [scripts/scaffold_python.py](scripts/scaffold_python.py): runnable scaffold that writes a starter `kavach_setup.py` plus an example policy file.
- [assets/policies.example.toml](assets/policies.example.toml): the kitchen-sink TOML policy exercising every condition variant.

## What to avoid

- Do not present `kavach-http`, `kavach-mcp`, or `kavach-redis` (multi-replica deployments) as ready-to-ship. They exist in the upstream library but the consumer-validation harness does not yet exercise them end-to-end. Point users at the [Kavach roadmap](https://github.com/SarthiAI/Kavach/blob/main/docs/roadmap.md) for those surfaces.
- Do not suggest the Node SDK for installation. The code lives in the upstream repo but is not yet published to npm.
- Do not change `Gate` to fail open under any circumstance, even temporarily for debugging. The library's contract is fail-closed; integrators rely on it.
- Do not skip invariants when refactoring policies. Invariants are the regulator-grade hard floor that beats any permissive policy. Removing them in favor of a `param_max` policy condition silently weakens the system.

## Verifying it works

A successful integration looks like this:

```python
verdict = gate.evaluate(ctx)
assert verdict.is_permit
assert verdict.permit_token is not None
assert verdict.permit_token.action_name == ctx.action_name
```

A correctly-failing integration looks like this:

```python
ctx_too_big = ActionContext(
    principal_id="agent-bot", principal_kind="agent",
    action_name="issue_refund",
    params={"amount": 99_999.0},
)
verdict = gate.evaluate(ctx_too_big)
assert verdict.is_refuse
assert verdict.evaluator == "invariants"
assert verdict.permit_token is None
```

Both are pinned by the runnable scenarios at [github.com/SarthiAI/Kavach/tree/main/business-tests-python](https://github.com/SarthiAI/Kavach/tree/main/business-tests-python). Forty-one scripts cover the full Python surface and run end-to-end in roughly five seconds.
