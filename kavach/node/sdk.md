# Node SDK reference

Detailed reference for the `kavach-sdk` npm package. For the policy schema (conditions, durations, time windows), see [policy-language.md](../references/policy-language.md). For drift, audit, and crypto, see the sibling reference docs in this folder.

## Install

```bash
npm install kavach-sdk
```

The package ships precompiled native bindings (napi-rs) per platform: macOS arm64 + x64, Linux x64 + arm64, Windows x64. There are no Node-side runtime dependencies; every algorithm runs in compiled Rust.

## Imports

```typescript
import {
  Gate,
  KavachRefused,
  KavachInvalidated,
  KavachKeyPair,
  PqTokenSigner,
  AuditEntry,
  SignedAuditChain,
  PublicKeyDirectory,
  DirectoryTokenVerifier,
  SecureChannel,
  InMemoryInvalidationBroadcaster,
  spawnInvalidationListener,
  McpKavachMiddleware,
  InMemorySessionStore,
  HttpKavachMiddleware,
  type EvaluateOptions,
  type PermitTokenInput,
  type GeoLocationInput,
  type DeviceFingerprintInput,
  type Verdict,
} from "kavach-sdk";
```

## Constructing a Gate

There are five loaders. Pick by where the policy data lives.

```typescript
const gate = Gate.fromObject(policyObject);     // plain JS object (recommended for programmatic policy)
const gate = Gate.fromJsonString(jsonString);   // JSON over the wire
const gate = Gate.fromJsonFile("kavach.json");  // JSON file on disk
const gate = Gate.fromToml(tomlString);         // operator-edited TOML string
const gate = Gate.fromFile("kavach.toml");      // TOML file on disk
```

All five accept the same second-argument `GateOptions`:

| Field                | Type                              | Default | Purpose                                                                                                       |
| -------------------- | --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `invariants`         | `Invariant[]`                     | omitted | Hard caps that beat any permissive policy. Each entry is `{ name: string; field: string; maxValue: number }`. |
| `observeOnly`        | `boolean`                         | `false` | When `true`, every verdict surfaced to JS is a Permit. The full evaluator chain still runs; underlying refuse / invalidate decisions are emitted by the Rust core as `tracing` events at `INFO` level. |
| `maxSessionActions`  | `number`                          | omitted | Hard ceiling on the number of actions allowed per `sessionId`. Sessions exceeding the cap are invalidated.    |
| `enableDrift`        | `boolean`                         | `true`  | When `false`, all built-in drift detectors are disabled. Use this for service-to-service calls where drift is meaningless. |
| `tokenSigner`        | `PqTokenSigner`                   | omitted | Signs every Permit verdict with ML-DSA-65 (or hybrid ML-DSA-65 + Ed25519). Sign-failure falls closed to Refuse. |
| `geoDriftMaxKm`      | `number`                          | omitted | Switches the geo drift detector to tolerant mode with a same-country distance threshold in kilometers.        |
| `broadcaster`        | `InMemoryInvalidationBroadcaster` | omitted | Cross-replica invalidation publisher. Every Invalidate verdict is also broadcast on this channel.             |

Empty policies are valid:

```typescript
const gate = Gate.fromObject({ policies: [] });  // default-deny everything
```

This is the recommended kill switch via `gate.reload("")`.

## EvaluateOptions

```typescript
const verdict = gate.evaluate({
  principalId: "agent-bot",
  principalKind: "agent",
  actionName: "issue_refund",
  params: { amount: 500 },           // numbers AND strings allowed; SDK splits them
});
```

Required fields: `principalId`, `principalKind`, `actionName`. Everything else is optional and is consumed only by conditions or detectors that need it.

| Field                | Type                              | Consumed by                                          |
| -------------------- | --------------------------------- | ---------------------------------------------------- |
| `principalId`        | `string`                          | always (rate-limit bucket, `identity_id` condition)  |
| `principalKind`      | `"user" \| "agent" \| "service" \| "scheduler" \| "external"` | always (`identity_kind` condition) |
| `actionName`         | `string`                          | always (`action` condition, audit chain)             |
| `params`             | `Record<string, number \| string>` | numeric guards (`param_max`, `param_min`), invariants, `param_in` string allow-lists. The SDK splits number-valued and string-valued keys internally. |
| `roles`              | `string[]`                        | `identity_role` condition                            |
| `resource`           | `string` (optional)               | `resource` condition                                 |
| `sessionId`          | `string` (UUID; see note)         | `session_age_max`, drift, audit                      |
| `sessionStartedAt`   | `number` (unix epoch seconds)     | `session_age_max`, behavior drift                    |
| `actionCount`        | `number` (unsigned int)           | behavior drift                                       |
| `ip`                 | `string` (optional)               | geo drift (current IP)                               |
| `originIp`           | `string` (optional)               | geo drift (origin IP, overrides the `ip`-derived origin) |
| `currentGeo`         | `GeoLocationInput`                | geo drift (current location)                         |
| `originGeo`          | `GeoLocationInput`                | geo drift (login origin)                             |
| `device`             | `DeviceFingerprintInput`          | device drift (current device)                        |
| `originDevice`       | `DeviceFingerprintInput`          | device drift (origin device)                         |

`principalKind` is one of `"user"`, `"agent"`, `"service"`, `"scheduler"`, `"external"`. Anything else throws.

`sessionId` is parsed as a UUID. Always pass a UUID string (`randomUUID()` from `node:crypto`).

### Mixed-type params

Unlike Python's two-step `params={...} + with_param(...)` pattern, the Node SDK accepts mixed numeric and string params directly:

```typescript
gate.evaluate({
  principalId: "agent-bot",
  principalKind: "agent",
  actionName: "issue_refund",
  params: {
    amount: 500,        // numeric, drives param_max / param_min and invariants
    currency: "INR",    // string, drives param_in
    region: "ap-south-1",
  },
});
```

The exported helper `splitParams(params)` returns the two engine-side maps if you need them yourself (HTTP middleware, MCP middleware, etc.).

## Verdict shape

`gate.evaluate(...)` returns a `Verdict` (the type alias for `VerdictResult`) with the following attributes:

| Attribute              | Type                | Set on            | Meaning                                                                  |
| ---------------------- | ------------------- | ----------------- | ------------------------------------------------------------------------ |
| `isPermit`             | `boolean`           | always            | Convenience: `kind === "permit"`.                                        |
| `isRefuse`             | `boolean`           | always            | Convenience: `kind === "refuse"`.                                        |
| `isInvalidate`         | `boolean`           | always            | Convenience: `kind === "invalidate"`.                                    |
| `kind`                 | `string`            | always            | One of `"permit"`, `"refuse"`, `"invalidate"`.                           |
| `evaluator`            | `string \| undefined` | refuse, invalidate | One of `"policy"`, `"drift"`, `"invariants"`, `"gate"`, `"session_store"`. Identity checks run inside the policy evaluator, there is no separate `"identity"` value. |
| `code`                 | `string \| undefined` | refuse           | One of `"NO_POLICY_MATCH"`, `"POLICY_DENIED"`, `"RATE_LIMIT_EXCEEDED"`, `"INVARIANT_VIOLATION"`, `"DRIFT_DETECTED"`, `"SESSION_INVALID"`, `"IDENTITY_FAILED"`, or `"PERMIT_EXPIRED"`. |
| `reason`               | `string \| undefined` | refuse, invalidate | Human-readable reason. Includes policy name where relevant.            |
| `tokenId`              | `string \| undefined` | permit           | UUID. Convenience accessor; same value lives at `verdict.permitToken.tokenId`. |
| `permitToken`          | `PermitTokenView \| undefined` | permit  | Full signed token (see below).                                          |
| `signature`            | `Buffer \| undefined` | permit           | Convenience getter for `verdict.permitToken.signature`. `undefined` for an unsigned permit and for Refuse / Invalidate. |

A typical integration looks like this:

```typescript
const verdict = gate.evaluate(ctx);
if (verdict.isPermit) {
  await proceedWithAction(ctx, verdict.permitToken!);
} else if (verdict.isRefuse) {
  log.warn("blocked", { evaluator: verdict.evaluator, code: verdict.code, reason: verdict.reason });
  return userFacingDenial(verdict.reason!);
} else if (verdict.isInvalidate) {
  await invalidateSession(ctx.sessionId!);
  forceRelogin();
}
```

If you would rather throw on Refuse and Invalidate instead of branching, see `Gate.check(...)` below.

## Gate.check(opts)

`Gate.check(opts)` evaluates the action context and throws if the verdict is not a Permit. Returns nothing on Permit.

```typescript
import { KavachRefused, KavachInvalidated } from "kavach-sdk";

try {
  gate.check(ctx);
} catch (e) {
  if (e instanceof KavachRefused) {
    log.warn("blocked", { evaluator: e.evaluator, code: e.code, reason: e.reason });
    return userFacingDenial(e.reason);
  }
  if (e instanceof KavachInvalidated) {
    log.warn("session killed", { evaluator: e.evaluator, reason: e.reason });
    await invalidateSession(ctx.sessionId!);
    forceRelogin();
    return;
  }
  throw e;
}

// Permit path: gate.check returned cleanly.
await proceedWithAction(ctx);
```

Both error classes carry the same fields as the corresponding `Verdict` attributes:

- `KavachRefused.reason`, `KavachRefused.evaluator`, `KavachRefused.code`.
- `KavachInvalidated.reason`, `KavachInvalidated.evaluator`.

If you need the signed `permitToken` (to forward downstream) or you want to inspect the verdict for any reason, use `gate.evaluate(ctx)` instead, since `check` discards the verdict on the Permit path.

## PermitToken

When a `PqTokenSigner` is attached to the gate, every Permit verdict carries a full signed envelope:

```typescript
const verdict = gate.evaluate(ctx);
if (verdict.isPermit) {
  const pt = verdict.permitToken!;
  pt.tokenId;          // UUID string
  pt.evaluationId;     // UUID string, distinct from tokenId
  pt.issuedAt;         // unix seconds (number)
  pt.expiresAt;        // unix seconds (number)
  pt.actionName;       // echoes ctx.actionName
  pt.signature;        // Buffer, opaque
}
```

Downstream services verify the token without sharing key material:

```typescript
import type { PermitTokenInput } from "kavach-sdk";

const reconstructed: PermitTokenInput = {
  tokenId: pt.tokenId,
  evaluationId: pt.evaluationId,
  issuedAt: pt.issuedAt,
  expiresAt: pt.expiresAt,
  actionName: pt.actionName,
};
signer.verify(reconstructed, pt.signature!);  // throws on tamper / wrong key / mode mismatch; returns void on success
```

For details on PQ-only vs hybrid signing and the directory-based verification flow, see [audit-and-pq.md](audit-and-pq.md).

## McpKavachMiddleware (`guardTool`, `evaluateToolCall`, `checkToolCall`)

For MCP tool-call wrappers, prefer the middleware over manually building the action context:

```typescript
import { Gate, McpKavachMiddleware, InMemorySessionStore } from "kavach-sdk";

const gate = Gate.fromObject(policy);
const middleware = new McpKavachMiddleware(gate, {
  sessionStore: new InMemorySessionStore(),  // optional, gives cross-replica fast-path on invalidate
});

const issueRefund = middleware.guardTool(
  "issue_refund",
  async (params: { orderId: string; amount: number }) => {
    return { status: "refunded", orderId: params.orderId, amount: params.amount };
  },
  { callerId: "agent-bot", callerKind: "agent" },
);

const result = await issueRefund({ orderId: "ORD-123", amount: 500 });
```

How the middleware works:

- `guardTool(name, handler, callerInfo)` returns a wrapped async function. It calls `gate.check(...)` first; on Refuse it throws `KavachRefused`; on Invalidate it throws `KavachInvalidated`; on Permit it calls the wrapped handler with the original arguments.
- `evaluateToolCall(name, params, callerInfo)` is the non-throwing variant returning the full `Verdict`. Use this when you want to inspect or log the verdict regardless of outcome.
- `checkToolCall(name, params, callerInfo)` mirrors `gate.check`: throws on Refuse or Invalidate, returns void on Permit.
- `invalidateSession(sessionId)` writes to the configured `sessionStore` so subsequent tool calls on that session are short-circuited to Invalidate before the gate runs.

`callerInfo` accepts `callerId`, `callerKind`, optional `sessionId`, `roles`, `ip`, `currentGeo`, `originGeo`, `device`, `originDevice`, `sessionStartedAt`, `actionCount`, etc., the same drift-detector fields as `EvaluateOptions`.

## Hot reload

```typescript
gate.reload(newPolicyToml);
```

Accepts a TOML string. On parse error, throws and leaves the previous good policy set untouched. Reload is `&self` under the hood (no `&mut`), so it is safe to call from any task that holds a reference to the `Gate`.

The empty-TOML kill switch:

```typescript
gate.reload("");  // installs an empty PolicySet; deny everything
```

For file-watch driven reload, run a Node `fs.watch` (or `chokidar`) handler on the policy file and call `gate.reload(readFileSync(path, "utf-8"))` on every successful read. Debounce is your responsibility; the Rust core ships an opt-in `notify`-based watcher with 250ms default debounce but that surface is not currently exposed through napi.

## Observe mode

Observe mode runs the full evaluator chain (policy, drift, invariants) on every call but never blocks: every `gate.evaluate(...)` returns a Permit, and `gate.check(...)` never throws. The underlying refuse / invalidate decisions are emitted by the Rust core as `tracing` events at `INFO` level with the message `"observe-only: would have blocked this action"`, `evaluation_id` (UUID), and `action` (action name) fields.

```typescript
const gate = Gate.fromObject(policy, { observeOnly: true });
const verdict = gate.evaluate(ctx);
console.assert(verdict.isPermit);  // always Permit in observe mode
await proceedWithAction(ctx);
```

There is **no** `verdict.wouldHaveBeen` attribute. The Node `Verdict` is always Permit-shaped in observe mode; the only signal of "would have blocked" is the Rust tracing log line.

To capture and act on that signal from JS, wire a `SignedAuditChain` (or your own audit sink) around `gate.evaluate` in observe mode: log the request plus a synthetic `AuditEntry` keyed by `evaluationId`. This is the recommended pattern; it gives you a programmatic record you can query, alert on, and replay against new policies.

A typical observe-then-enforce rollout:

1. Deploy with `observeOnly: true` and a `SignedAuditChain` recording every call.
2. Watch the chain for entries the gate would have refused; iterate on the policy until the false-positive rate is acceptable.
3. Flip to `observeOnly: false`. The chain stays in place as the production audit trail; refuse / invalidate verdicts now reach the caller.

Invariants run in observe mode too (the chain is full); they are simply suppressed in the surfaced verdict like every other refuse path.

## Cross-replica invalidation broadcast

`InMemoryInvalidationBroadcaster` is the in-process publish / subscribe channel for `Verdict::Invalidate` events. Construct the gate with `broadcaster: ...` in `GateOptions` and every Invalidate verdict the gate produces is also published on that broadcaster so any listener can fan out the kill (e.g. wipe a session cache, force a re-login on every other replica).

```typescript
import {
  Gate,
  InMemoryInvalidationBroadcaster,
  spawnInvalidationListener,
} from "kavach-sdk";

const broadcaster = new InMemoryInvalidationBroadcaster();
const gate = Gate.fromObject(policy, { broadcaster });

const handle = spawnInvalidationListener(broadcaster, (scope) => {
  // scope.targetKind === "session" | "principal" | "role"
  // scope.targetId   === UUID string (session) | principal id | role name
  // scope.reason, scope.evaluator
  dropSessionLocally(scope.targetId);
});

// ... gate produces Invalidate verdicts in normal flow; the callback fires ...

handle.abort();   // stop the listener; subsequent invalidations on this broadcaster are no-ops here.
```

The callback runs on the Node event loop via a `ThreadsafeFunction`; exceptions thrown inside the callback are caught and logged to stderr, they never crash the listener task.

### Publishing a synthetic invalidation (for tests)

The `InvalidationScopeView` interface has no constructor on the JS side; it is only ever produced by the Rust core. To exercise a listener pipeline without routing a real Invalidate verdict through the gate, call `broadcaster.publish(...)` directly. The method takes positional arguments and is synchronous (returns `void`, not a Promise):

```typescript
import { randomUUID } from "node:crypto";

broadcaster.publish(
  "session",                       // targetKind: "session" | "principal" | "role"
  randomUUID(),                    // targetId (see note below)
  "test invalidation",             // reason (shown in the InvalidationScopeView handed to listeners)
  "manual",                        // evaluator (optional; defaults to "manual")
);
```

`targetId` parsing is strict per `targetKind`:

- `"session"`: must be a valid UUID string. A non-UUID rejects.
- `"principal"`: any string (the principal id).
- `"role"`: any string (the role name).

Use this exclusively for tests, fixtures, and admin tooling; production invalidations should always come through `Gate.evaluate(...)` so the evaluator-level reasoning is preserved.

## Errors thrown by the SDK

| Error                | Properties                                       | When                                                                                       |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `Error`              |                                                  | Bad policy (parse error, typo'd condition name, unknown enum value). napi surfaces these as plain `Error`. |
| `KavachRefused`      | `reason: string`, `evaluator: string`, `code: string` | Thrown by `Gate.check(...)`, `middleware.checkToolCall(...)`, and `middleware.guardTool(...)` wrappers on Refuse. |
| `KavachInvalidated`  | `reason: string`, `evaluator: string`            | Thrown by the same surfaces on Invalidate.                                                 |

`Gate.evaluate(...)` itself does not throw on a Refuse or Invalidate verdict; it returns the verdict and lets the caller branch. `Gate.check(...)` is the throwing form.

## Common pitfalls

1. **Treating empty policies as a no-op.** An empty PolicySet denies everything. If you want a permissive default for testing, write a policy with `effect: "permit"` and `conditions: []` (an empty condition list matches every context).
2. **Reusing one `principalId` for unrelated calls.** Rate-limit buckets are keyed `principalId:actionName`, so two unrelated agents under one ID share a bucket and one will starve the other.
3. **Calling `evaluate` from inside a tight `for`-loop without batching.** Every call crosses the FFI boundary; in CPU-bound bursts you want to evaluate once per logical action, not per inner iteration.
4. **Installing third-party crypto libraries to handle Kavach signatures.** Do not `npm install @noble/post-quantum`, `ml-dsa`, or any other crypto package to sign or verify Kavach permit tokens, audit chains, or `SecureChannel` payloads. The `kavach-sdk` napi package ships every algorithm Kavach uses (ML-DSA-65, ML-KEM-768, Ed25519, X25519, ChaCha20-Poly1305) compiled in. Verification happens through `PqTokenSigner.verify(...)` or `DirectoryTokenVerifier.verify(...)`, both exposed by the same package. A separate library is not needed and is not guaranteed to be interoperable.
5. **Forgetting to `await` async middleware methods.** `middleware.evaluateToolCall`, `checkToolCall`, `guardTool`-wrapped handlers, and `invalidateSession` are all async. Missing `await` returns a Promise the gate has not yet finished evaluating.

## Where to look for more

- [../references/policy-language.md](../references/policy-language.md) for the condition grammar.
- [drift-detectors.md](drift-detectors.md) for `DeviceFingerprintInput`, `GeoLocationInput`, session-age and behavior drift.
- [audit-and-pq.md](audit-and-pq.md) for signed permits, the audit chain, and the public-key directory.
- [secure-channel.md](secure-channel.md) for `SecureChannel` (encrypted, signed, replay-protected byte channels between two peers).
- [github.com/SarthiAI/Kavach/tree/main/business-tests-node](https://github.com/SarthiAI/Kavach/tree/main/business-tests-node) for twenty-one runnable scenarios that exercise the full Node surface end-to-end.
