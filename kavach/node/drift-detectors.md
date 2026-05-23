# Drift detectors

Drift detectors run as the third evaluator in the gate chain (after identity and policy, before invariants). They detect that something about the principal's runtime context has changed in a way that should block the action or invalidate the session.

A drift Violation always produces a `Verdict::Invalidate` (`verdict.isInvalidate === true`, `evaluator === "drift"`, `code` is `undefined`), not a Refuse. Drift signals are designed to mean "the session itself is no longer trustworthy", so the caller is expected to drop the session and force a fresh login or re-attestation. A Refuse from the drift evaluator only happens when multiple concurrent Warnings (sub-violation signals, e.g. tolerant-mode geo hops near the threshold) stack up past the gate's warning threshold; that path is rare in practice and never sets `code` to `"DRIFT_DETECTED"` per detector.

Four detectors ship out of the box, all reachable from the Node SDK through `EvaluateOptions` fields. None of them need explicit setup; constructing a `Gate` wires them in by default. The optional `geoDriftMaxKm` field on `GateOptions` switches the geo detector into tolerant mode.

## The four detectors

| Detector        | Triggers when                                                                 | `EvaluateOptions` fields it reads                       |
| --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| Device          | Current device fingerprint hash differs from the origin device                | `device`, `originDevice`                                |
| Geo             | Current geo differs from origin geo (strict country match, or distance threshold) | `ip`, `originIp`, `currentGeo`, `originGeo`         |
| Session age     | `now - sessionStartedAt > policy session_age_max`                             | `sessionStartedAt`                                      |
| Behavior (action count) | High action volume relative to session age                            | `sessionStartedAt`, `actionCount`                       |

A detector that needs a field which is missing fails the verdict closed, never silently. If `geoDriftMaxKm` is set but you do not pass `currentGeo` and `originGeo`, the verdict is a Violation, not a bypass.

To skip drift evaluation entirely (useful for service-to-service calls where drift is meaningless), construct the gate with `enableDrift: false`.

## DeviceFingerprintInput

`DeviceFingerprintInput` is a plain object: a single stable hash plus an optional human-readable description (used in violation messages). The Node SDK does not interpret the hash, you compute it from whatever signals you have on the client side.

```typescript
import { createHash } from "node:crypto";
import { Gate, type DeviceFingerprintInput } from "kavach-sdk";

function fingerprintFor(userAgent: string, platform: string, screen: string, tz: string): DeviceFingerprintInput {
  const raw = [userAgent, platform, screen, tz].join("|");
  const digest = createHash("sha256").update(raw).digest("hex");
  return { hash: digest, description: `${platform} / ${tz}` };
}

const current = fingerprintFor("Mozilla/5.0 ...", "macOS", "2560x1440", "Asia/Kolkata");
const origin  = fingerprintFor("Mozilla/5.0 ...", "macOS", "2560x1440", "Asia/Kolkata");  // recorded at session start

const verdict = gate.evaluate({
  principalId: "user-42",
  principalKind: "user",
  actionName: "transfer_funds",
  device: current,
  originDevice: origin,
});
```

The detector compares the two `hash` strings. Identical hashes pass; different hashes trigger a Drift Violation, which surfaces as `verdict.isRefuse` with `verdict.evaluator === "drift"`. There are no per-field weights or partial matches; the hash is opaque to the gate.

Pick a hashing strategy that is stable across legitimate sessions but changes when the device materially changes. Common signals: user-agent, platform, screen resolution, timezone, IP-routed ASN, mobile-OS device ID. Hash them with SHA-256 (or any cryptographic hash) and pass the digest. The library does not care about the algorithm; it only compares strings.

`description` is optional and shows up in the violation reason text. Use it for whatever is most useful to your incident-review workflow (`"macOS / Asia/Kolkata"`, `"iPhone iOS 18 / IST"`, etc.).

## GeoLocationInput, strict and tolerant modes

`GeoLocationInput` is a plain object: `{ countryCode, region?, city?, latitude?, longitude? }`. Only `countryCode` is required; `region` and `city` are free-text annotations used in violation messages; `latitude` / `longitude` unlock tolerant mode (Haversine distance).

**The geo check is gated by an IP transition.** The detector returns `Stable` (no violation) unless both `ip` and `originIp` are present AND they differ. If the IP stays the same, the geo coordinates are not consulted at all, so a same-IP request from a different country reads as no drift. Always populate `ip` / `originIp` together with `currentGeo` / `originGeo` for the geo check to engage.

```typescript
import type { GeoLocationInput } from "kavach-sdk";

const current: GeoLocationInput = { countryCode: "IN", region: "Tamil Nadu", city: "Chennai", latitude: 13.08, longitude: 80.27 };
const origin:  GeoLocationInput = { countryCode: "IN", region: "Karnataka",  city: "Bangalore", latitude: 12.97, longitude: 77.59 };
```

### Strict mode (default)

When you do not pass `geoDriftMaxKm`, the detector compares country codes only. Same country passes; cross-country triggers a Drift Violation.

### Tolerant mode

When you pass `geoDriftMaxKm` to the gate constructor, same-country IP hops within the threshold become Warnings instead of Violations. Cross-country hops are still Violations regardless of distance. Missing geo with a threshold set still **fails closed**, the SDK does not silently bypass.

```typescript
import { randomUUID } from "node:crypto";
import { Gate } from "kavach-sdk";

const gate = Gate.fromObject(policy, { geoDriftMaxKm: 500 });

const verdict = gate.evaluate({
  principalId: "user-42",
  principalKind: "user",
  actionName: "view_profile",
  ip: "2.3.4.5",
  sessionId: randomUUID(),
  currentGeo: { countryCode: "IN", city: "Chennai",   latitude: 13.08, longitude: 80.27 },
  originGeo:  { countryCode: "IN", city: "Bangalore", latitude: 12.97, longitude: 77.59 },
});
// Bangalore to Chennai is roughly 290 km, well within the 500 km threshold.
// verdict.isPermit is true (assuming policy permits).
```

Pick `geoDriftMaxKm` based on the legitimate movement profile of your principals. For consumer apps in a single country, 500 km catches sessions that hop cities while still flagging cross-region anomalies. For traveling sales teams, 5000 km is reasonable.

## Session age

The session-age drift detector reads `sessionStartedAt` from the context. There is no SDK-level configuration; the threshold is set per-policy via the `session_age_max` condition (see [policy-language.md](../references/policy-language.md#session_age_max)). The Node SDK accepts `sessionStartedAt` as a unix-epoch number (seconds since 1970-01-01 UTC), not a `Date`.

```typescript
import { randomUUID } from "node:crypto";

const fiveHoursAgo = Math.floor(Date.now() / 1000) - 5 * 3600;

const verdict = gate.evaluate({
  principalId: "user-42",
  principalKind: "user",
  actionName: "transfer_funds",
  sessionId: randomUUID(),
  sessionStartedAt: fiveHoursAgo,
});
```

A policy with `session_age_max = "4h"` refuses this context (the session is 5 hours old, exceeds 4 hours). The detector itself surfaces a refusal only when the policy condition is present and exceeded; without a policy condition, session age is just metadata.

## Behavior (action count)

The behavior-drift detector reads `sessionStartedAt` and `actionCount` together. It triggers when the action volume is too high for how long the session has been alive (a fresh session firing dozens of actions per minute looks like an attack).

```typescript
const verdict = gate.evaluate({
  principalId: "user-42",
  principalKind: "user",
  actionName: "transfer_funds",
  sessionId: randomUUID(),
  sessionStartedAt: Math.floor(Date.now() / 1000) - 60,   // session 1 minute old
  actionCount: 200,                                        // but already 200 actions in
});
```

The detector ratio is internal to the SDK and not currently configurable per-policy. Increment `actionCount` on every gate call you make for a given session: if you reuse the same options object across calls without bumping the count, the detector never fires.

## Verdict behavior

When a detector triggers a Violation, the verdict is:

```typescript
verdict.isRefuse;      // true
verdict.evaluator;     // "drift"
verdict.code;          // "DRIFT_DETECTED"
verdict.reason;        // human-readable, e.g. "device fingerprint changed mid-session"
```

When a detector triggers an Invalidation (used when the drift is severe enough that the entire session should be killed, not just the action):

```typescript
verdict.isInvalidate;  // true
verdict.evaluator;     // "drift"
```

In `guardTool` / `checkToolCall` usage, an Invalidate verdict throws `KavachInvalidated`. The middleware does not call the wrapped handler; the caller is expected to drop the session and force a re-login.

## What drift detectors do not do

- They do not store anything. The detector compares the values you pass in `EvaluateOptions`. If you want persistent device or geo history, you maintain it on your side and pass `originDevice` / `originGeo` from your records.
- They do not call out to third-party services (no IP geolocation lookup, no device-fingerprint API). The SDK is offline; you populate the context, the gate evaluates.
- They do not bypass on missing data. Missing `currentGeo` with `geoDriftMaxKm` set is a Violation, not a bypass. The library's contract is fail-closed across every evaluator.
