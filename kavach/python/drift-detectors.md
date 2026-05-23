# Drift detectors

Drift detectors run as the third evaluator in the gate chain (after identity and policy, before invariants). They detect that something about the principal's runtime context has changed in a way that should block the action or invalidate the session.

Four detectors ship out of the box, all reachable from Python through `ActionContext` fields. None of them need explicit setup; constructing a `Gate` wires them in by default. The optional `geo_drift_max_km` keyword on `Gate.from_dict` (and the other loaders) switches the geo detector into tolerant mode.

## The four detectors

| Detector        | Triggers when                                                                 | `ActionContext` fields it reads                          |
| --------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| Device          | Current device fingerprint hash differs from the origin device                | `device`, `origin_device`                                |
| Geo             | Current geo differs from origin geo (strict country match, or distance threshold) | `ip`, `origin_ip`, `current_geo`, `origin_geo`       |
| Session age     | `now - session_started_at > policy session_age_max`                           | `session_started_at`                                     |
| Behavior (action count) | High action volume relative to session age                            | `session_started_at`, `action_count`                     |

A detector that needs a field which is missing fails the verdict closed, never silently. If a `geo_drift_max_km` is set but you do not pass `current_geo` and `origin_geo`, the verdict is a Violation, not a bypass.

To skip drift evaluation entirely (useful for service-to-service calls where drift is meaningless), construct the gate with `enable_drift=False`.

## DeviceFingerprint

`DeviceFingerprint(hash, description=None)` is the actual constructor: a single stable hash plus an optional human-readable description (used in violation messages). The Python SDK does not interpret the hash, you compute it from whatever signals you have on the client side.

```python
import hashlib
from kavach import DeviceFingerprint

def fingerprint_for(user_agent: str, platform: str, screen: str, tz: str) -> DeviceFingerprint:
    raw = "|".join([user_agent, platform, screen, tz]).encode()
    digest = hashlib.sha256(raw).hexdigest()
    return DeviceFingerprint(digest, description=f"{platform} / {tz}")

current = fingerprint_for("Mozilla/5.0 ...", "macOS", "2560x1440", "Asia/Kolkata")
origin  = fingerprint_for("Mozilla/5.0 ...", "macOS", "2560x1440", "Asia/Kolkata")  # what was recorded at session start

ctx = ActionContext(
    principal_id="user-42",
    principal_kind="user",
    action_name="transfer_funds",
    device=current,
    origin_device=origin,
)
```

The detector compares the two `hash` strings. Identical hashes pass; different hashes trigger a Drift Violation, which surfaces as `verdict.is_refuse` with `verdict.evaluator == "drift"`. There are no per-field weights or partial matches; the hash is opaque to the gate.

Pick a hashing strategy that is stable across legitimate sessions but changes when the device materially changes. Common signals: user-agent, platform, screen resolution, timezone, IP-routed ASN, mobile-OS device ID. Hash them with SHA-256 (or any cryptographic hash) and pass the digest. The library does not care about the algorithm; it only compares strings.

`description` is optional and shows up in the violation reason text. Use it for whatever is most useful to your incident-review workflow (`"macOS / Asia/Kolkata"`, `"iPhone iOS 18 / IST"`, etc.).

## GeoLocation, strict and tolerant modes

`GeoLocation(country_code, region=None, city=None, latitude=None, longitude=None)` is the constructor. Only `country_code` is required; `region` and `city` are free-text annotations used in violation messages; `latitude` / `longitude` unlock tolerant mode (Haversine distance).

**The geo check is gated by an IP transition.** The detector returns `Stable` (no violation) unless both `ip` and `origin_ip` are present AND they differ. If the IP stays the same, the geo coordinates are not consulted at all, so a same-IP request from a different country reads as no drift. Always populate `ip` / `origin_ip` together with `current_geo` / `origin_geo` for the geo check to engage.

```python
from kavach import GeoLocation

current = GeoLocation("IN", region="Tamil Nadu",  city="Chennai",   latitude=13.08, longitude=80.27)
origin  = GeoLocation("IN", region="Karnataka",   city="Bangalore", latitude=12.97, longitude=77.59)
```

### Strict mode (default)

When you do not pass `geo_drift_max_km`, the detector compares country codes only. Same country passes; cross-country triggers a Drift Violation.

### Tolerant mode

When you pass `geo_drift_max_km` to the gate constructor, same-country IP hops within the threshold become Warnings instead of Violations. Cross-country hops are still Violations regardless of distance. Missing geo with a threshold set still **fails closed**, the SDK does not silently bypass.

```python
gate = Gate.from_dict(policy, geo_drift_max_km=500.0)

import uuid

verdict = gate.evaluate(ActionContext(
    principal_id="user-42", principal_kind="user",
    action_name="view_profile",
    ip="2.3.4.5",
    session_id=str(uuid.uuid4()),
    current_geo=GeoLocation("IN", city="Chennai",   latitude=13.08, longitude=80.27),
    origin_geo =GeoLocation("IN", city="Bangalore", latitude=12.97, longitude=77.59),
))
# Bangalore to Chennai is roughly 290 km, well within the 500 km threshold.
# verdict.is_permit is True (assuming policy permits).
```

Pick `geo_drift_max_km` based on the legitimate movement profile of your principals. For consumer apps in a single country, 500 km catches sessions that hop cities while still flagging cross-region anomalies. For traveling sales teams, 5 000 km is reasonable.

## Session age

The session-age drift detector reads `session_started_at` from the context. There is no SDK-level configuration; the threshold is set per-policy via the `session_age_max` condition (see [policy-language.md](../references/policy-language.md#session_age_max)). The Python constructor accepts `session_started_at` as a unix-epoch integer (seconds since 1970-01-01 UTC), not a `datetime`.

```python
import time
import uuid
from kavach import ActionContext

five_hours_ago = int(time.time()) - 5 * 3600

ctx = ActionContext(
    principal_id="user-42",
    principal_kind="user",
    action_name="transfer_funds",
    session_id=str(uuid.uuid4()),
    session_started_at=five_hours_ago,
)
```

A policy with `session_age_max = "4h"` refuses this context (the session is 5 hours old, exceeds 4 hours). The detector itself surfaces a refusal only when the policy condition is present and exceeded; without a policy condition, session age is just metadata.

## Behavior (action count)

The behavior-drift detector reads `session_started_at` and `action_count` together. It triggers when the action volume is too high for how long the session has been alive (a fresh session firing dozens of actions per minute looks like an attack).

```python
ctx = ActionContext(
    principal_id="user-42",
    principal_kind="user",
    action_name="transfer_funds",
    session_id=str(uuid.uuid4()),
    session_started_at=int(time.time()) - 60,   # session 1 minute old
    action_count=200,                            # but already 200 actions in
)
```

The detector ratio is internal to the SDK and not currently configurable per-policy from Python. Increment `action_count` on every gate call you make for a given session: if you build the `ActionContext` once and reuse it, the count never updates and the detector never fires. Make a fresh `ActionContext` per call, or mutate the field before each `gate.evaluate(...)`.

## Verdict behavior

When a detector triggers a Violation, the verdict is:

```python
verdict.is_refuse      # True
verdict.evaluator      # "drift"
verdict.code           # "DRIFT_DETECTED"
verdict.reason         # human-readable, e.g. "device fingerprint changed mid-session"
```

When a detector triggers an Invalidation (used when the drift is severe enough that the entire session should be killed, not just the action):

```python
verdict.is_invalidate  # True
verdict.evaluator      # "drift"
```

In `@guarded` decorator usage, an Invalidate verdict raises `kavach.Invalidated`. The decorator does not call the wrapped function; the caller is expected to drop the session and force a re-login.

## What drift detectors do not do

- They do not store anything. The detector compares the values you pass in `ActionContext`. If you want persistent device or geo history, you maintain it on your side and pass `origin_device` / `origin_geo` from your records.
- They do not call out to third-party services (no IP geolocation lookup, no device-fingerprint API). The SDK is offline; you populate the context, the gate evaluates.
- They do not bypass on missing data. Missing `current_geo` with `geo_drift_max_km` set is a Violation, not a bypass. The library's contract is fail-closed across every evaluator.
