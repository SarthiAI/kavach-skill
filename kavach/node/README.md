# Kavach, Node / TypeScript integration

This is the Node entry point for the Kavach skill. Read [../SKILL.md](../SKILL.md) first if you need the conceptual overview; this doc assumes you already know what the gate, drift detectors, signed permits, and audit chain do, and you want to write TypeScript or JavaScript code against them.

## Install

```bash
npm install kavach-sdk
```

The package is published as `kavach-sdk` on npm. Import the surface you need:

```typescript
import { Gate } from "kavach-sdk";
```

Compiled native bindings (napi-rs) ship per platform. macOS arm64 + x64, Linux x64 + arm64, and Windows x64 are supported. There are no Node-side runtime dependencies; everything below the import surface is compiled Rust loaded over napi.

## Shortest working example

```typescript
import { Gate } from "kavach-sdk";

const policy = {
  policies: [
    {
      name: "agent_small_refunds",
      effect: "permit",
      conditions: [
        { identity_kind: "agent" },
        { action: "issue_refund" },
        { param_max: { field: "amount", max: 1000.0 } },
      ],
    },
  ],
};

const gate = Gate.fromObject(policy, {
  invariants: [{ name: "hard_cap", field: "amount", maxValue: 50_000 }],
});

const verdict = gate.evaluate({
  principalId: "agent-bot",
  principalKind: "agent",
  actionName: "issue_refund",
  params: { amount: 500 },
});

if (verdict.isPermit) {
  console.log("permit", verdict.tokenId);
} else {
  console.log(`blocked: [${verdict.code}] ${verdict.evaluator}: ${verdict.reason}`);
}
```

Load-bearing details to communicate to the user:

- **No matching permit means Refuse.** There is no implicit allow. An empty policy set is valid (it denies everything, useful as a kill switch via hot reload).
- **Invariants beat policies.** The `invariants` array is a hard cap on a numeric param. Even a permit verdict from the policy phase gets overturned by a violating invariant.
- **Typo'd condition names throw.** `{ idnetity_kind: "agent" }` throws an `Error` instead of being silently ignored. This is true for `fromObject`, `fromToml`, and the JSON loaders alike.

## Loading policies, the five ways

```typescript
const gate = Gate.fromObject(policyObject);       // plain JS object (recommended for programmatic policy)
const gate = Gate.fromJsonString(jsonString);     // JSON over the wire (REST API, ConfigMap)
const gate = Gate.fromJsonFile("kavach.json");    // JSON file on disk
const gate = Gate.fromToml(tomlString);           // operator-edited TOML
const gate = Gate.fromFile("kavach.toml");        // TOML file on disk
```

All five produce an identical `Gate` and identical evaluation. Pick by where the policy lives, not by what it does. Hand-edited config in git: TOML. Programmatic construction from TypeScript: object. JSON over the wire: JSON. The condition vocabulary, defaults, and fail-closed semantics are the same.

For the full grammar of conditions, priorities, durations, and time-window syntax, read [../references/policy-language.md](../references/policy-language.md).

## EvaluateOptions fields you actually need

| Field                | Required for                                   | Notes                                                         |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `principalId`        | always                                         | Stable string. Used as the rate-limit bucket prefix.          |
| `principalKind`      | always                                         | One of `"user"`, `"agent"`, `"service"`, `"scheduler"`, `"external"`. |
| `actionName`         | always                                         | Used by the `action` condition. Wildcards via trailing `*`.   |
| `params`             | numeric guards (`param_max`, `param_min`), invariants, `param_in` string allow-lists | `Record<string, number \| string>`. Numbers drive the numeric guards; strings drive `param_in`. The SDK splits them internally. |
| `roles`              | `identity_role` conditions                     | Array of strings. Order does not matter.                      |
| `resource`           | `resource` conditions                          | Optional. Missing resource fails the condition (closed).      |
| `sessionId`          | `session_age_max`, behavior drift, audit       | UUID string. Always pass `randomUUID()` from `node:crypto`.   |
| `sessionStartedAt`   | `session_age_max`, behavior drift              | Unix epoch seconds (`number`). Required when using session-age drift. |
| `actionCount`        | behavior drift                                 | Unsigned integer. Caller increments per action.               |
| `ip`, `originIp`     | geo drift                                      | IP strings; `originIp` overrides the `ip`-derived session origin. |
| `currentGeo`, `originGeo` | geo drift                                | `GeoLocationInput`. See [drift-detectors.md](drift-detectors.md). |
| `device`, `originDevice` | device drift                               | `DeviceFingerprintInput` (`{ hash, description? }`). See drift-detectors doc. |

Anything you do not pass is simply not evaluated. Drift conditions that need a missing field fail closed, never silently bypass.

## `guardTool` middleware (the Node equivalent of `@guarded`)

For MCP tool-call wrappers, use `McpKavachMiddleware.guardTool` instead of building the action context by hand:

```typescript
import { Gate, McpKavachMiddleware } from "kavach-sdk";

const gate = Gate.fromObject(policy);
const middleware = new McpKavachMiddleware(gate);

const issueRefund = middleware.guardTool(
  "issue_refund",
  async (params: { orderId: string; amount: number }) => {
    return { status: "refunded", orderId: params.orderId, amount: params.amount };
  },
  { callerId: "agent-bot", callerKind: "agent" },
);

const result = await issueRefund({ orderId: "ORD-123", amount: 500 });
```

The middleware checks the action through the gate before calling your handler. Refuse and Invalidate verdicts throw `KavachRefused` and `KavachInvalidated` respectively, so wrap calls in `try / catch` if you want to log or surface the rejection.

## Hot reload and the empty-policy kill switch

```typescript
gate.reload(newPolicyToml);
```

`reload` accepts a TOML string. It throws on parse error and leaves the previous good set untouched. Reloading with `""` (empty TOML) installs an empty PolicySet, which means *deny everything*. That is the recommended kill switch for "stop all agent actions, now" and the safest possible default state.

## Observe-only rollout

To stage Kavach without blocking traffic, construct the gate with `observeOnly: true`:

```typescript
const gate = Gate.fromObject(policy, { observeOnly: true });
```

In observe mode, every `gate.evaluate(...)` returns a Permit and `gate.check(...)` never throws. The full evaluator chain (policy, drift, invariants) still runs; underlying refuse / invalidate decisions are emitted by the Rust core as `tracing` events at `INFO` level. There is no `verdict.wouldHaveBeen` attribute.

To get programmatic visibility, wire a `SignedAuditChain` (or your own logger) around `gate.evaluate` and record every call: when you flip `observeOnly: false` later, the same chain becomes the production audit trail.

## Deeper reference

- [sdk.md](sdk.md): full Node surface (`Gate` options, `Gate.check`, `KavachRefused` / `KavachInvalidated` errors, hot reload, observe-only mode, `splitParams` helper).
- [drift-detectors.md](drift-detectors.md): device, geo, session-age, action-count detectors and their `EvaluateOptions` fields.
- [audit-and-pq.md](audit-and-pq.md): `KavachKeyPair`, `PqTokenSigner` (PQ-only and hybrid), `SignedAuditChain`, `PublicKeyDirectory`, JSONL export and verification.
- [secure-channel.md](secure-channel.md): `SecureChannel`, encrypted + signed + replay-protected byte channels between two peers.
- [scaffold.ts](scaffold.ts): runnable scaffold that writes a starter `kavach_setup.ts` plus an example policy file.
- [../assets/policies.example.toml](../assets/policies.example.toml): the kitchen-sink TOML policy exercising every condition variant.
- [../references/policy-language.md](../references/policy-language.md): condition vocabulary, duration syntax, time-window grammar.

## Verifying it works

A successful integration looks like this:

```typescript
const verdict = gate.evaluate(ctx);
console.assert(verdict.isPermit);
console.assert(verdict.permitToken != null);
console.assert(verdict.permitToken!.actionName === ctx.actionName);
```

A correctly-failing integration looks like this:

```typescript
const verdict = gate.evaluate({
  principalId: "agent-bot",
  principalKind: "agent",
  actionName: "issue_refund",
  params: { amount: 99_999 },
});
console.assert(verdict.isRefuse);
console.assert(verdict.evaluator === "invariants");
console.assert(verdict.permitToken == null);
```

Both are pinned by the runnable scenarios at [github.com/SarthiAI/Kavach/tree/main/business-tests-node](https://github.com/SarthiAI/Kavach/tree/main/business-tests-node). Twenty-one scripts cover the full Node surface and run end-to-end in roughly twelve seconds, mirroring the Python suite one-to-one.
