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

All five accept the same keyword arguments (all keyword-only):

| Kwarg                  | Type                              | Default | Purpose                                                                                                       |
| ---------------------- | --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `invariants`           | `list[tuple[str, str, float]]`    | `None`  | Hard caps that beat any permissive policy. Each tuple is `(invariant_name, param_field, max_value)`.          |
| `observe_only`         | `bool`                            | `False` | When `True`, every verdict surfaced to Python is a Permit. The full evaluator chain still runs; underlying refuse / invalidate decisions are emitted as Rust `tracing` logs at `INFO` level (event message `"observe-only: would have blocked this action"` with `evaluation_id` and `action` fields). See "Observe mode" below for how to capture the signal. |
| `max_session_actions`  | `int`                             | `None`  | Hard ceiling on the number of actions allowed per `session_id`. Sessions exceeding the cap are invalidated.   |
| `enable_drift`         | `bool`                            | `True`  | When `False`, all built-in drift detectors are disabled. Use this for service-to-service calls where drift is meaningless. |
| `token_signer`         | `PqTokenSigner`                   | `None`  | Signs every Permit verdict with ML-DSA-65 (or hybrid ML-DSA-65 + Ed25519). Sign-failure falls closed to Refuse. |
| `geo_drift_max_km`     | `float`                           | `None`  | Switches the geo drift detector to tolerant mode with a same-country distance threshold in kilometers.        |

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
    params={"amount": 500.0},          # numeric params only via the constructor
)
ctx.with_param("currency", "INR")        # string params via with_param after construction
```

Required positional / keyword fields: `principal_id`, `principal_kind`, `action_name`. Everything else is optional and is consumed only by conditions or detectors that need it.

| Field                    | Type                              | Consumed by                                          |
| ------------------------ | --------------------------------- | ---------------------------------------------------- |
| `principal_id`           | `str`                             | always (rate-limit bucket, `identity_id` condition)  |
| `principal_kind`         | `str` enum                        | always (`identity_kind` condition)                   |
| `action_name`            | `str`                             | always (`action` condition, audit chain)             |
| `params`                 | `dict[str, float]` (numeric only) | numeric guards (`param_max`, `param_min`), invariants. See "String params" below. |
| `roles`                  | `list[str]`                       | `identity_role` condition                            |
| `resource`               | `str` (optional)                  | `resource` condition                                 |
| `session_id`             | `str` (UUID; see note)            | `session_age_max`, drift, audit                      |
| `session_started_at`     | `int` (unix epoch seconds)        | `session_age_max`, behavior drift                    |
| `action_count`           | `int` (unsigned)                  | behavior drift                                       |
| `ip`                     | `str` (optional)                  | geo drift (current IP)                               |
| `origin_ip`              | `str` (optional)                  | geo drift (origin IP, overrides the `ip`-derived origin) |
| `current_geo`            | `GeoLocation`                     | geo drift (current location)                         |
| `origin_geo`             | `GeoLocation`                     | geo drift (login origin)                             |
| `device`                 | `DeviceFingerprint`               | device drift (current device)                        |
| `origin_device`          | `DeviceFingerprint`               | device drift (origin device)                         |

`principal_kind` is one of `"user"`, `"agent"`, `"service"`, `"scheduler"`, `"external"`. Anything else raises `ValueError`.

`session_id` is parsed as a UUID. If the string is not a valid UUID, the gate **silently** substitutes a fresh random UUID, which means rate-limit and drift state will not match between calls that share a non-UUID session string. Always pass UUIDs (e.g. `str(uuid.uuid4())`) for `session_id`.

There is no `evaluated_at` parameter on the constructor; the gate uses `chrono::Utc::now()` internally for time-window evaluation. If you need to evaluate against a specific clock for testing, drive the gate from a context whose conditions do not depend on `time_window`, or use observe mode with synthetic logs.

### String params

The constructor's `params=` argument accepts only numeric (`int` or `float`) values, because PyO3 extracts every value as `f64`. To pass a string parameter (used by the `param_in` condition, e.g. `currency`, `region`, `country_code`), call `with_param(key, value)` on the constructed context:

```python
ctx = ActionContext(
    principal_id="agent-bot",
    principal_kind="agent",
    action_name="issue_refund",
    params={"amount": 500.0},          # numeric only here
)
ctx.with_param("currency", "INR")        # string params via with_param
ctx.with_param("region", "ap-south-1")
```

`with_param` accepts numeric, string, and bool values, and overwrites any prior value at the same key. Run all `with_param` calls before `gate.evaluate(ctx)`.

## Verdict shape

`gate.evaluate(ctx)` returns a `Verdict` with the following attributes:

| Attribute              | Type                | Set on  | Meaning                                                                  |
| ---------------------- | ------------------- | ------- | ------------------------------------------------------------------------ |
| `is_permit`            | `bool`              | always  | Convenience: `kind == "permit"`.                                         |
| `is_refuse`            | `bool`              | always  | Convenience: `kind == "refuse"`.                                         |
| `is_invalidate`        | `bool`              | always  | Convenience: `kind == "invalidate"`.                                     |
| `kind`                 | `str`               | always  | One of `"permit"`, `"refuse"`, `"invalidate"`.                           |
| `evaluator`            | `str`               | refuse, invalidate | One of `"policy"`, `"drift"`, `"invariants"`, or `"gate"` (gate-level errors: session already invalidated, token-signer failure). Identity checks run inside the policy evaluator, there is no separate `"identity"` value. |
| `code`                 | `str`               | refuse  | One of `"NO_POLICY_MATCH"`, `"POLICY_DENIED"`, `"RATE_LIMIT_EXCEEDED"`, `"INVARIANT_VIOLATION"`, `"DRIFT_DETECTED"`, `"SESSION_INVALID"`, `"IDENTITY_FAILED"` (used for token-signer failures), or `"PERMIT_EXPIRED"`. `None` on Invalidate. |
| `reason`               | `str`               | refuse, invalidate | Human-readable reason. Includes policy name where relevant.   |
| `token_id`             | `str`               | permit  | UUID. Convenience accessor; same value lives at `verdict.permit_token.token_id`. |
| `permit_token`         | `PermitToken`       | permit  | Full signed token (see below).                                           |
| `signature`            | `bytes`             | permit  | Convenience getter for `verdict.permit_token.signature`. `None` for an unsigned permit, `None` for Refuse / Invalidate. |

A typical integration looks like this:

```python
verdict = gate.evaluate(ctx)
if verdict.is_permit:
    proceed_with_action(ctx, token=verdict.permit_token)
elif verdict.is_refuse:
    log.warning("blocked", evaluator=verdict.evaluator, code=verdict.code, reason=verdict.reason)
    return user_facing_denial(verdict.reason)
elif verdict.is_invalidate:
    invalidate_session(ctx.session_id)
    force_relogin()
```

If you would rather raise on Refuse and Invalidate instead of branching, see `Gate.check(ctx)` below.

## Gate.check(ctx)

`Gate.check(ctx)` evaluates the action context and raises if the verdict is not a Permit. It returns `None` on Permit. This is the raise-on-block shorthand the `@guarded` decorator is built on top of, and the right surface for code that does not need to introspect the Permit verdict (no signed-token forwarding, no observe-mode logging).

```python
from kavach import Refused, Invalidated

try:
    gate.check(ctx)
except Refused as exc:
    log.warning("blocked", evaluator=exc.evaluator, code=exc.code, reason=exc.reason)
    return user_facing_denial(exc.reason)
except Invalidated as exc:
    log.warning("session killed", evaluator=exc.evaluator, reason=exc.reason)
    invalidate_session(ctx.session_id)
    force_relogin()

# Permit path: gate.check returned cleanly, proceed.
proceed_with_action(ctx)
```

Both exception classes carry the same fields as the corresponding `Verdict` attributes:

- `Refused.reason`, `Refused.evaluator`, `Refused.code`.
- `Invalidated.reason`, `Invalidated.evaluator`.

If you need the signed `PermitToken` (to forward downstream) or you want to inspect the verdict for any reason, use `Gate.evaluate(ctx)` instead, since `check` discards the verdict on the Permit path.

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
signer.verify(reconstructed, pt.signature)   # raises ValueError on tamper / wrong key / mode mismatch; returns None on success
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

- It strips the following underscore-prefixed kwargs from the call to build an `ActionContext`: `_principal_id`, `_principal_kind`, `_roles`, `_resource`, `_ip`, `_session_id`. Anything else is passed through to the wrapped function unchanged. Defaults: `_principal_id="unknown"`, `_principal_kind="user"`, `_roles=[]`.
- It maps named function arguments to `params` via `param_fields={"policy_param_name": "function_arg_name"}`. Only numeric values (`int` or `float`) are forwarded; the gate's policy and invariant evaluators only operate on numbers, so non-numeric arguments are skipped.
- It calls `gate.check(ctx)` first; on Refuse it raises `kavach.Refused`; on Invalidate it raises `kavach.Invalidated`; on Permit it calls the wrapped function with the cleaned-up kwargs.
- Both async and sync wrapped functions are supported. The decorator detects which by checking `inspect.iscoroutinefunction(fn)` and returns the matching wrapper shape (sync in, sync wrapper out; async in, async out).

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

Observe mode runs the full evaluator chain (policy, drift, invariants) on every call but never blocks: every `gate.evaluate(ctx)` returns a Permit, and `gate.check(ctx)` never raises. The underlying refuse / invalidate decisions are emitted by the Rust core as `tracing` events at `INFO` level with the message `"observe-only: would have blocked this action"`, `evaluation_id` (UUID), and `action` (action name) fields.

```python
gate = Gate.from_dict(policy, observe_only=True)
verdict = gate.evaluate(ctx)
assert verdict.is_permit                  # always Permit in observe mode
proceed_with_action(ctx)
```

There is **no** `verdict.would_have_been` attribute. The Python `Verdict` is always Permit-shaped in observe mode; the only signal of "would have blocked" is the Rust tracing log line.

To capture and act on that signal from Python, do one of the following:

- **Wire a `SignedAuditChain` (or your own audit sink) around `gate.evaluate`** in observe mode: log the `ActionContext` plus a synthetic `AuditEntry` keyed by `evaluation_id`. This is the recommended pattern; it gives you a programmatic record you can query, alert on, and replay against new policies.
- **Bridge the Rust `tracing` logs into Python logging** using a crate like `tracing-log` at the Rust layer if you have a custom embedding, or rely on stderr capture for simpler deployments.

A typical observe-then-enforce rollout:

1. Deploy with `observe_only=True` and a `SignedAuditChain` recording every call.
2. Watch the chain for entries the gate would have refused; iterate on the policy until the false-positive rate is acceptable.
3. Flip to `observe_only=False`. The chain stays in place as the production audit trail; refuse / invalidate verdicts now reach the caller.

Invariants run in observe mode too (the chain is full); they are simply suppressed in the surfaced verdict like every other refuse path.

## Errors raised by the SDK

| Exception              | Attributes                                  | When                                                                                       |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ValueError`           |                                             | Bad policy (parse error, typo'd condition name, unknown enum value).                       |
| `kavach.Refused`       | `reason: str`, `evaluator: str`, `code: str` | Raised by `Gate.check(ctx)` and the `@guarded` decorator on Refuse.                       |
| `kavach.Invalidated`   | `reason: str`, `evaluator: str`             | Raised by `Gate.check(ctx)` and the `@guarded` decorator on Invalidate.                    |
| `RuntimeError`         |                                             | Internal Rust panic surfaced through PyO3. Should never happen in normal use; file a bug.  |

`Gate.evaluate(ctx)` itself does not raise on a Refuse or Invalidate verdict; it returns the verdict and lets the caller branch. `Gate.check(ctx)` is the raising form (see below).

## Common pitfalls

1. **Using the package name as the import name.** `pip install kavach-sdk`, but `from kavach import ...`. The artifact name and the import name differ on purpose (the unscoped `kavach` name was already taken on PyPI when the library shipped).
2. **Forgetting that invariants need a numeric param.** `[("hard_cap", "amount", 50_000.0)]` only fires when `ctx.params["amount"]` is present and numeric. Missing or non-numeric values fail closed.
3. **Treating empty policies as a no-op.** An empty PolicySet denies everything. If you want a permissive default for testing, write a `[[policy]]` with `effect = "permit"` and `conditions = []` (an empty condition list matches every context).
4. **Reusing one `principal_id` for unrelated calls.** Rate-limit buckets are keyed `principal_id:action_name`, so two unrelated agents under one ID share a bucket and one will starve the other.
5. **Calling `evaluate` from inside a tight `for`-loop without batching.** Every call crosses the FFI boundary; in CPU-bound bursts you want to evaluate once per logical action, not per inner iteration.

## Where to look for more

- [policy-language.md](policy-language.md) for the condition grammar.
- [drift-detectors.md](drift-detectors.md) for `DeviceFingerprint`, `GeoLocation`, session-age and behavior drift.
- [audit-and-pq.md](audit-and-pq.md) for signed permits, the audit chain, and the public-key directory.
- [secure-channel.md](secure-channel.md) for `SecureChannel` (encrypted, signed, replay-protected byte channels between two peers).
- [github.com/SarthiAI/Kavach/tree/main/business-tests-python](https://github.com/SarthiAI/Kavach/tree/main/business-tests-python) for forty-one runnable scenarios that exercise the full Python surface end-to-end.
