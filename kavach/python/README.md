# Kavach, Python integration

This is the Python entry point for the Kavach skill. Read [../SKILL.md](../SKILL.md) first if you need the conceptual overview; this doc assumes you already know what the gate, drift detectors, signed permits, and audit chain do, and you want to write Python code against them.

## Install

```bash
pip install kavach-sdk
```

The package is published as `kavach-sdk` on PyPI but the import name is `kavach`:

```python
from kavach import Gate, ActionContext
```

A single `abi3` wheel per platform covers CPython 3.10, 3.11, 3.12, and every future Python.

## Shortest working example

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

Load-bearing details to communicate to the user:

- **No matching permit means Refuse.** There is no implicit allow. An empty policy set is valid (it denies everything, useful as a kill switch via hot reload).
- **Invariants beat policies.** The third tuple element in `invariants=[...]` is a hard cap on a numeric param. Even a permit verdict from the policy phase gets overturned by a violating invariant.
- **Typo'd condition names raise.** `{"idnetity_kind": "agent"}` raises `ValueError` instead of being silently ignored. This is true for `from_dict`, `from_toml`, and the JSON loaders alike.

## Loading policies, the five ways

```python
gate = Gate.from_dict(policy_dict)          # native Python dict (recommended for programmatic policy)
gate = Gate.from_json_string(json_string)   # JSON over the wire (REST API, ConfigMap)
gate = Gate.from_json_file("kavach.json")   # JSON file on disk
gate = Gate.from_toml(toml_string)          # operator-edited TOML
gate = Gate.from_file("kavach.toml")        # TOML file on disk
```

All five produce an identical `Gate` and identical evaluation. Pick by where the policy lives, not by what it does. Hand-edited config in git: TOML. Programmatic construction from Python: dict. JSON over the wire: JSON. The condition vocabulary, defaults, and fail-closed semantics are the same.

For the full grammar of conditions, priorities, durations, and time-window syntax, read [../references/policy-language.md](../references/policy-language.md).

## ActionContext fields you actually need

| Field                | Required for                                   | Notes                                                         |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `principal_id`       | always                                         | Stable string. Used as the rate-limit bucket prefix.          |
| `principal_kind`     | always                                         | One of `"user"`, `"agent"`, `"service"`, `"scheduler"`, `"external"`. |
| `action_name`        | always                                         | Used by the `action` condition. Wildcards via trailing `*`.   |
| `params`             | numeric guards (`param_max`, `param_min`), invariants | `dict[str, float]`. Constructor accepts only numeric values; for string params (`param_in`, e.g. `currency`), call `ctx.with_param("currency", "INR")` after construction. |
| `roles`              | `identity_role` conditions                     | List of strings. Order does not matter.                       |
| `resource`           | `resource` conditions                          | Optional. Missing resource fails the condition (closed).      |
| `session_id`         | `session_age_max`, behavior drift, audit       | UUID string. A non-UUID value is silently replaced with a fresh random UUID, always pass `str(uuid.uuid4())`. |
| `session_started_at` | `session_age_max`, behavior drift              | Unix epoch seconds (`int`). Required when using session-age drift. |
| `action_count`       | behavior drift                                 | Unsigned integer. Caller increments per action.               |
| `ip`, `origin_ip`    | geo drift                                      | IP strings; `origin_ip` overrides the `ip`-derived session origin. |
| `current_geo`, `origin_geo` | geo drift                               | `GeoLocation`. See [drift-detectors.md](drift-detectors.md).  |
| `device`, `origin_device` | device drift                              | `DeviceFingerprint(hash, description=None)`. See drift-detectors doc. |

Anything you do not pass is simply not evaluated. Drift conditions that need a missing field fail closed, never silently bypass. There is no `evaluated_at` constructor field; the gate uses the system clock for `time_window` evaluation.

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

## `McpKavachMiddleware` for MCP servers

For Python MCP servers (single `call_tool` loop dispatching by tool name), prefer the middleware over the decorator:

```python
from kavach import Gate, McpKavachMiddleware, InMemorySessionStore

gate = Gate.from_file("kavach.toml")
kavach = McpKavachMiddleware(gate, session_store=InMemorySessionStore())

kavach.check_tool_call(
    tool_name="issue_refund",
    params={"amount": 500},
    caller_id="agent-bot",
    caller_kind="agent",
    session_id=session_uuid,
)
# Reaching here means the gate permitted.
```

Methods: `check_tool_call(...)` raises `kavach.Refused` / `kavach.Invalidated` on a block; `evaluate_tool_call(...)` returns the `Verdict` instead of raising; `invalidate_session(sid)` revokes a session (fans out via the session store to peer replicas); `get_session(sid)` returns the local view. For the full method surface and argument list, see [sdk.md](sdk.md#mckavachmiddleware-check_tool_call-evaluate_tool_call-invalidate_session).

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

In observe mode, every `gate.evaluate(ctx)` returns a Permit and `gate.check(ctx)` never raises. The full evaluator chain (policy, drift, invariants) still runs; underlying refuse / invalidate decisions are emitted by the Rust core as `tracing` events at `INFO` level with the message `"observe-only: would have blocked this action"`. There is no `verdict.would_have_been` attribute on the Python `Verdict`.

To get programmatic visibility, wire a `SignedAuditChain` (or your own logger) around `gate.evaluate` and record every call: when you flip `observe_only=False` later, the same chain becomes the production audit trail. See [sdk.md](sdk.md#observe-mode) for the full rollout pattern.

## Deeper reference

- [sdk.md](sdk.md): full Python surface (Gate kwargs, `Gate.check`, `@guarded` decorator, `McpKavachMiddleware`, `Refused` / `Invalidated` exceptions, hot reload, observe-only mode).
- [drift-detectors.md](drift-detectors.md): device, geo, session-age, action-count detectors and their `ActionContext` fields.
- [audit-and-pq.md](audit-and-pq.md): `KavachKeyPair`, `PqTokenSigner` (PQ-only and hybrid), `SignedAuditChain`, `PublicKeyDirectory`, JSONL export and verification.
- [secure-channel.md](secure-channel.md): `SecureChannel`, encrypted + signed + replay-protected byte channels between two peers.
- [scaffold.py](scaffold.py): runnable scaffold that writes a starter `kavach_setup.py` plus an example policy file.
- [../assets/policies.example.toml](../assets/policies.example.toml): the kitchen-sink TOML policy exercising every condition variant.
- [../references/policy-language.md](../references/policy-language.md): condition vocabulary, duration syntax, time-window grammar.

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

Both are pinned by the runnable scenarios at [github.com/SarthiAI/Kavach/tree/main/business-tests-python](https://github.com/SarthiAI/Kavach/tree/main/business-tests-python). Twenty-one scripts cover the full Python surface and run end-to-end in roughly thirteen seconds.
