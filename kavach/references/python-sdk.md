# Python SDK reference

Detailed reference for the `kavach` Python package (published as `kavach-sdk` on PyPI). For the policy schema (conditions, durations, time windows), see [policy-language.md](policy-language.md). For drift, audit, and crypto, see the sibling reference docs.

## Install

```bash
pip install kavach-sdk
```

The package ships as a single `abi3` wheel per platform. CPython 3.10, 3.11, 3.12, and every future Python use the same wheel. Linux x86_64 and aarch64, macOS x86_64 and arm64, and Windows x64 are supported. There are no Python-side runtime dependencies; everything below the import surface is compiled Rust loaded over PyO3.

The import name is `kavach`, not `kavach_sdk`.

```python
from kavach import (
    ActionContext, Gate, Verdict, PermitToken,
    DeviceFingerprint, GeoLocation,
    KavachKeyPair, PqTokenSigner,
    AuditEntry, SignedAuditChain,
    PublicKeyDirectory, DirectoryTokenVerifier,
    SecureChannel,
    guarded,
)
```

## Constructing a Gate

There are five loaders. Pick by where the policy data lives.

```python
gate = Gate.from_dict(policy_dict)              # native Python dict (recommended for programmatic policy)
gate = Gate.from_json_string(json_string)       # JSON over the wire
gate = Gate.from_json_file("kavach.json")       # JSON file on disk
gate = Gate.from_toml(toml_string)              # operator-edited TOML string
gate = Gate.from_file("kavach.toml")            # TOML file on disk
```

All five accept the same keyword arguments:

| Kwarg                | Type                              | Purpose                                                                                                       |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `invariants`         | `list[tuple[str, str, float]]`    | Hard caps that beat any permissive policy. Each tuple is `(invariant_name, param_field, max_value)`.          |
| `token_signer`       | `PqTokenSigner`                   | Signs every Permit verdict with ML-DSA-65 (or hybrid ML-DSA-65 + Ed25519).                                    |
| `observe_only`       | `bool`                            | When `True`, every verdict is a Permit; the would-have-been verdict lives on `verdict.would_have_been`.       |
| `geo_drift_max_km`   | `float`                           | Switches the geo drift detector to tolerant mode with a same-country distance threshold in kilometers.        |

Empty policies are valid:

```python
gate = Gate.from_dict({"policies": []})  # default-deny everything
```

This is the recommended kill switch via `gate.reload("")`.

## ActionContext

```python
ctx = ActionContext(
    principal_id="agent-bot",
    principal_kind="agent",
    action_name="issue_refund",
    params={"amount": 500.0, "currency": "INR"},
)
```

Required positional / keyword fields: `principal_id`, `principal_kind`, `action_name`. Everything else is optional and is consumed only by conditions or detectors that need it.

| Field                    | Type                          | Consumed by                                          |
| ------------------------ | ----------------------------- | ---------------------------------------------------- |
| `principal_id`           | `str`                         | always (rate-limit bucket, `identity_id` condition)  |
| `principal_kind`         | `str` enum                    | always (`identity_kind` condition)                   |
| `action_name`            | `str`                         | always (`action` condition, audit chain)             |
| `params`                 | `dict[str, Any]`              | numeric guards, invariants                           |
| `roles`                  | `list[str]`                   | `identity_role` condition                            |
| `resource`               | `str` (optional)              | `resource` condition                                 |
| `session_id`             | `str`                         | `session_age_max`, drift, audit                      |
| `session_started_at`     | `datetime`                    | `session_age_max`, drift                             |
| `action_count`           | `int`                         | action-count drift                                   |
| `ip`                     | `str` (optional)              | geo drift                                            |
| `current_geo`            | `GeoLocation`                 | geo drift (current location)                         |
| `origin_geo`             | `GeoLocation`                 | geo drift (login origin)                             |
| `device`                 | `DeviceFingerprint`           | device drift (current device)                        |
| `origin_device`          | `DeviceFingerprint`           | device drift (origin device)                         |
| `evaluated_at`           | `datetime`                    | `time_window` condition. Defaults to now if unset.   |

`principal_kind` is one of `"user"`, `"agent"`, `"service"`, `"scheduler"`, `"external"`. Anything else raises.

## Verdict shape

`gate.evaluate(ctx)` returns a `Verdict` with the following attributes:

| Attribute              | Type                | Set on  | Meaning                                                                  |
| ---------------------- | ------------------- | ------- | ------------------------------------------------------------------------ |
| `is_permit`            | `bool`              | always  | Convenience: `kind == "permit"`.                                         |
| `is_refuse`            | `bool`              | always  | Convenience: `kind == "refuse"`.                                         |
| `is_invalidate`        | `bool`              | always  | Convenience: `kind == "invalidate"`.                                     |
| `kind`                 | `str`               | always  | One of `"permit"`, `"refuse"`, `"invalidate"`.                           |
| `evaluator`            | `str`               | refuse  | One of `"identity"`, `"policy"`, `"drift"`, `"invariants"`.              |
| `code`                 | `str`               | refuse  | Reason code, e.g. `"NO_POLICY_MATCH"`, `"INVARIANT_VIOLATION"`.          |
| `reason`               | `str`               | refuse  | Human-readable reason. Includes policy name where relevant.              |
| `token_id`             | `str`               | permit  | UUID. Convenience accessor; same value lives at `verdict.permit_token.token_id`. |
| `permit_token`         | `PermitToken`       | permit  | Full signed token (see below).                                           |
| `would_have_been`      | `Verdict`           | observe | Set only when `observe_only=True`. The verdict the real gate would have produced. |

A successful integration looks like this:

```python
verdict = gate.evaluate(ctx)
if verdict.is_permit:
    proceed_with_action(ctx, token=verdict.permit_token)
elif verdict.is_refuse:
    log.warning("blocked", evaluator=verdict.evaluator, code=verdict.code, reason=verdict.reason)
    raise ActionDenied(verdict.reason)
elif verdict.is_invalidate:
    invalidate_session(ctx.session_id)
    raise SessionRevoked()
```

## PermitToken

When a `PqTokenSigner` is attached to the gate, every Permit verdict carries a full signed envelope:

```python
verdict = gate.evaluate(ctx)
if verdict.is_permit:
    pt = verdict.permit_token
    pt.token_id        # UUID string
    pt.evaluation_id   # UUID string, distinct from token_id
    pt.issued_at       # unix seconds (int)
    pt.expires_at      # unix seconds (int)
    pt.action_name     # echoes ctx.action_name
    pt.signature       # bytes, opaque
```

Downstream services verify the token without sharing key material:

```python
from kavach import PermitToken

reconstructed = PermitToken(
    token_id=pt.token_id,
    evaluation_id=pt.evaluation_id,
    issued_at=pt.issued_at,
    expires_at=pt.expires_at,
    action_name=pt.action_name,
)
assert signer.verify(reconstructed, pt.signature)
```

For details on PQ-only vs hybrid signing and the directory-based verification flow, see [audit-and-pq.md](audit-and-pq.md).

## The `@guarded` decorator

```python
from kavach import guarded

@guarded(gate, action="issue_refund", param_fields={"amount": "amount"})
async def issue_refund(order_id: str, amount: float):
    return {"status": "refunded", "order_id": order_id, "amount": amount}

result = await issue_refund(
    "ORD-123", 500.0,
    _principal_id="agent-bot", _principal_kind="agent",
)
```

How the decorator works:

- It builds an `ActionContext` from the `_principal_id`, `_principal_kind`, and any other `_`-prefixed kwargs the caller passes.
- It maps named function arguments to `params` via `param_fields={"function_arg_name": "policy_param_name"}`. Only numeric values are forwarded.
- It calls `gate.evaluate(...)` first; on Refuse it raises `kavach.ActionDenied`; on Invalidate it raises `kavach.SessionInvalidated`; on Permit it calls the wrapped function.
- Both async and sync wrapped functions are supported. The decorator returns the matching wrapper shape (sync function in, sync wrapper out; async in, async out).

For LangChain or LangGraph integration, decorate the tool implementation directly:

```python
from langchain_core.tools import tool

@tool
@guarded(gate, action="search_orders", param_fields={"limit": "limit"})
def search_orders(query: str, limit: int = 10):
    ...
```

## Hot reload

```python
gate.reload(new_policy_toml)
```

Accepts a TOML string. On parse error, raises `ValueError` and leaves the previous good policy set untouched. Reload is `&self` under the hood (no `&mut`), so it is safe to call from any thread that holds a reference to the `Gate`.

The empty-TOML kill switch:

```python
gate.reload("")  # installs an empty PolicySet; deny everything
```

For file-watch driven reload, run a background task that watches the policy file and calls `gate.reload` on every successful parse. Debounce is your responsibility on the Python side; in the Rust core, the `kavach-core` crate ships an opt-in `notify`-based watcher with a 250ms default debounce, but that surface is not exposed to Python today.

## Observe mode

```python
gate = Gate.from_dict(policy, observe_only=True)
verdict = gate.evaluate(ctx)
assert verdict.is_permit                    # always
log.info("would_have", outcome=verdict.would_have_been.kind, reason=verdict.would_have_been.reason)
```

Use observe mode to stage Kavach without blocking traffic. Read `verdict.would_have_been` to log what the real gate would have done; flip `observe_only=False` when the log signal looks correct.

Observe mode does not bypass invariants in mode; it bypasses them in the verdict surfaced to the caller. The "would have been" verdict still reflects the full evaluator chain, including invariants.

## Errors raised by the SDK

| Exception                       | When                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `ValueError`                    | Bad policy (parse error, typo'd condition name, unknown enum value).                       |
| `kavach.ActionDenied`           | Raised by the `@guarded` decorator on Refuse.                                              |
| `kavach.SessionInvalidated`     | Raised by the `@guarded` decorator on Invalidate.                                          |
| `RuntimeError`                  | Internal Rust panic surfaced through PyO3. Should never happen in normal use; file a bug.  |

The `Gate.evaluate(...)` method itself does not raise on a Refuse or Invalidate verdict; the decorator does.

## Common pitfalls

1. **Using the package name as the import name.** `pip install kavach-sdk`, but `from kavach import ...`. The artifact name and the import name differ on purpose (the unscoped `kavach` name was already taken on PyPI when the library shipped).
2. **Forgetting that invariants need a numeric param.** `[("hard_cap", "amount", 50_000.0)]` only fires when `ctx.params["amount"]` is present and numeric. Missing or non-numeric values fail closed.
3. **Treating empty policies as a no-op.** An empty PolicySet denies everything. If you want a permissive default for testing, write a `[[policy]]` with `effect = "permit"` and `conditions = []` (an empty condition list matches every context).
4. **Reusing one `principal_id` for unrelated calls.** Rate-limit buckets are keyed `principal_id:action_name`, so two unrelated agents under one ID share a bucket and one will starve the other.
5. **Calling `evaluate` from inside a tight `for`-loop without batching.** Every call crosses the FFI boundary; in CPU-bound bursts you want to evaluate once per logical action, not per inner iteration.

## Where to look for more

- [policy-language.md](policy-language.md) for the condition grammar.
- [drift-detectors.md](drift-detectors.md) for `DeviceFingerprint`, `GeoLocation`, session-age and action-count drift.
- [audit-and-pq.md](audit-and-pq.md) for signed permits and the audit chain.
- [github.com/SarthiAI/Kavach/tree/main/business-tests-python](https://github.com/SarthiAI/Kavach/tree/main/business-tests-python) for forty-one runnable scenarios that exercise the full Python surface end-to-end.
