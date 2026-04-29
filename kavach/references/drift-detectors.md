# Drift detectors

Drift detectors run as the third evaluator in the gate chain (after identity and policy, before invariants). They detect that something about the principal's runtime context has changed in a way that should block the action or invalidate the session.

Four detectors ship out of the box, all reachable from Python through `ActionContext` fields. None of them need explicit setup; constructing a `Gate` wires them in by default. The optional `geo_drift_max_km` keyword on `Gate.from_dict` (and the other loaders) switches the geo detector into tolerant mode.

## The four detectors

| Detector       | Triggers when                                                                 | `ActionContext` fields it reads                          |
| -------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| Device         | Current device fingerprint differs from the origin device                     | `device`, `origin_device`                                |
| Geo            | Current geo differs from origin geo (strict country match, or distance threshold) | `ip`, `current_geo`, `origin_geo`                    |
| Session age    | `now - session_started_at > policy session_age_max`                           | `session_started_at`, `evaluated_at`                     |
| Action count   | `action_count > internal threshold`                                           | `action_count`                                           |

A detector that needs a field which is missing fails the verdict closed, never silently. If a `geo_drift_max_km` is set but you do not pass `current_geo` and `origin_geo`, the verdict is a Violation, not a bypass.

## DeviceFingerprint

A first-class SDK class. Construct it with whatever stable identifiers you can extract on the client side (browser fingerprint, mobile device ID, IP-routed ASN, etc.).

```python
from kavach import DeviceFingerprint

current = DeviceFingerprint(
    device_id="dev-abc-123",
    user_agent="Mozilla/5.0 ...",
    platform="macOS",
    screen_resolution="2560x1440",
    timezone="Asia/Kolkata",
)
origin = DeviceFingerprint(device_id="dev-abc-123")  # what was logged in originally

ctx = ActionContext(
    principal_id="user-42",
    principal_kind="user",
    action_name="transfer_funds",
    device=current,
    origin_device=origin,
)
```

The detector compares fingerprints field-by-field. Identical fingerprints pass; any divergence triggers a Drift Violation, which surfaces as `verdict.is_refuse` with `verdict.evaluator == "drift"`.

The `device_id` is the strongest signal. If you only have one identifier, use `device_id` and leave the rest unset.

## GeoLocation, strict and tolerant modes

```python
from kavach import GeoLocation

current = GeoLocation("IN", city="Chennai",   latitude=13.08, longitude=80.27)
origin  = GeoLocation("IN", city="Bangalore", latitude=12.97, longitude=77.59)
```

Only `country_code` is required. Latitude and longitude unlock tolerant mode (Haversine distance).

### Strict mode (default)

When you do not pass `geo_drift_max_km`, the detector compares country codes only. Same country passes; cross-country triggers a Drift Violation.

### Tolerant mode

When you pass `geo_drift_max_km` to the gate constructor, same-country IP hops within the threshold become Warnings instead of Violations. Cross-country hops are still Violations regardless of distance. Missing geo with a threshold set still **fails closed**, the SDK does not silently bypass.

```python
gate = Gate.from_dict(policy, geo_drift_max_km=500.0)

verdict = gate.evaluate(ActionContext(
    principal_id="user-42", principal_kind="user",
    action_name="view_profile",
    ip="2.3.4.5",
    session_id="sess-1",
    current_geo=GeoLocation("IN", city="Chennai",   latitude=13.08, longitude=80.27),
    origin_geo =GeoLocation("IN", city="Bangalore", latitude=12.97, longitude=77.59),
))
# Bangalore to Chennai is roughly 290 km, well within the 500 km threshold.
# verdict.is_permit is True (assuming policy permits).
```

Pick `geo_drift_max_km` based on the legitimate movement profile of your principals. For consumer apps in a single country, 500 km catches sessions that hop cities while still flagging cross-region anomalies. For traveling sales teams, 5 000 km is reasonable.

## Session age

The session-age drift detector reads `session_started_at` and `evaluated_at` from the context. There is no SDK-level configuration; the threshold is set per-policy via the `session_age_max` condition (see [policy-language.md](policy-language.md#session_age_max)).

```python
from datetime import datetime, timedelta, timezone

ctx = ActionContext(
    principal_id="user-42",
    principal_kind="user",
    action_name="transfer_funds",
    session_id="sess-1",
    session_started_at=datetime.now(timezone.utc) - timedelta(hours=5),
)
```

A policy with `session_age_max = "4h"` would refuse this context (session is 5 hours old, exceeds 4 hours). The detector itself surfaces a refusal only when the policy condition is present and exceeded; without a policy condition, session age is just metadata.

## Action count

Increment `action_count` on every gate call you make for a given session. The detector applies an internal threshold and triggers when the count exceeds expected per-session activity.

```python
ctx = ActionContext(
    principal_id="user-42",
    principal_kind="user",
    action_name="transfer_funds",
    session_id="sess-1",
    action_count=42,
)
```

This is the cheapest detector to wire and the easiest to forget. If you build the `ActionContext` once and reuse it, the count never updates. Make a fresh `ActionContext` per call, or mutate the field before each `gate.evaluate(...)`.

## Verdict behavior

When a detector triggers a Violation, the verdict is:

```python
verdict.is_refuse      # True
verdict.evaluator      # "drift"
verdict.code           # "DRIFT_VIOLATION"
verdict.reason         # human-readable, e.g. "device fingerprint changed: device_id mismatch"
```

When a detector triggers an Invalidation (used when the drift is severe enough that the entire session should be killed, not just the action):

```python
verdict.is_invalidate  # True
verdict.evaluator      # "drift"
```

In `@guarded` decorator usage, an Invalidate verdict raises `kavach.SessionInvalidated`. The decorator does not call the wrapped function; the caller is expected to drop the session and force a re-login.

## What drift detectors do not do

- They do not store anything. The detector compares the values you pass in `ActionContext`. If you want persistent device or geo history, you maintain it on your side and pass `origin_device` / `origin_geo` from your records.
- They do not call out to third-party services (no IP geolocation lookup, no device-fingerprint API). The SDK is offline; you populate the context, the gate evaluates.
- They do not bypass on missing data. Missing `current_geo` with `geo_drift_max_km` set is a Violation, not a bypass. The library's contract is fail-closed across every evaluator.
