# Policy language reference

The exhaustive grammar for the schema consumed by every Kavach loader. Same schema across `from_dict`, `from_json_string`, `from_json_file`, `from_toml`, and `from_file`. Pick the format that matches where the policy lives; the evaluation behavior is identical.

## File shape

A policy file (or in-memory object) wraps a list of `[[policy]]` entries. The TOML form uses array-of-tables; dict and JSON use a top-level `policies` key. The singular `policy` is also accepted as an alias.

### TOML

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

### Python dict

```python
{
    "policies": [
        {
            "name": "agent_small_refunds",
            "effect": "permit",
            "priority": 10,
            "conditions": [
                {"identity_kind": "agent"},
                {"action": "issue_refund"},
                {"param_max": {"field": "amount", "max": 5000.0}},
            ],
        },
    ],
}
```

### JSON

```json
{
  "policies": [
    {
      "name": "agent_small_refunds",
      "effect": "permit",
      "priority": 10,
      "conditions": [
        {"identity_kind": "agent"},
        {"action": "issue_refund"},
        {"param_max": {"field": "amount", "max": 5000.0}}
      ]
    }
  ]
}
```

An empty file (or `{"policies": []}`, or `Gate.from_toml("")`) is valid. It means default-deny everything, useful as a kill switch via `gate.reload("")`.

## `[[policy]]` fields

| Field         | Type             | Required | Default | Description                                                                  |
| ------------- | ---------------- | -------- | ------- | ---------------------------------------------------------------------------- |
| `name`        | string           | yes      | ,       | Human-readable identifier. Appears in refusal reasons and tracing.           |
| `effect`      | enum             | yes      | ,       | One of `"permit"` or `"refuse"`. Any other value is a parse error.           |
| `conditions`  | array of tables  | yes      | `[]`    | AND-combined list of conditions. Empty list matches every context.           |
| `description` | string           | no       | unset   | Free-form documentation. Not used during evaluation.                         |
| `priority`    | unsigned integer | no       | `100`   | Lower number is evaluated first. Ties fall back to declaration order.        |

### Effect values

| Value      | Meaning                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `"permit"` | First matching policy allows the action.                                 |
| `"refuse"` | First matching policy blocks the action with `RefuseCode::PolicyDenied`. |

## Condition grammar

Every condition table has exactly one key, which is the snake_case name of a condition variant. Multi-field variants use a nested table for the value.

| Key                | Arity              | Purpose                                                       |
| ------------------ | ------------------ | ------------------------------------------------------------- |
| `identity_kind`    | scalar             | Match `principal_kind`.                                       |
| `identity_role`    | scalar             | Match a string in `roles`.                                    |
| `identity_id`      | scalar             | Exact match against `principal_id`.                           |
| `action`           | scalar (pattern)   | Match action name. Trailing `*` allowed.                      |
| `resource`         | scalar (pattern)   | Match `resource`. Same wildcard grammar as `action`.          |
| `param_max`        | inline table       | Numeric upper bound on a `params` field.                      |
| `param_min`        | inline table       | Numeric lower bound on a `params` field.                      |
| `param_in`         | inline table       | String allow-list for a `params` field.                       |
| `rate_limit`       | inline table       | Sliding-window request count per principal per action.        |
| `session_age_max`  | scalar (duration)  | Maximum allowed session age.                                  |
| `time_window`      | scalar (window)    | Wall-clock gate, optionally timezone-suffixed.                |

All conditions in a `[[policy]]` are ANDed. To express OR, split into multiple `[[policy]]` entries at the same priority.

### `identity_kind`

| Value          | Meaning                              |
| -------------- | ------------------------------------ |
| `"user"`       | Human user.                          |
| `"agent"`      | AI agent (LLM, autonomous system).   |
| `"service"`    | Backend service or microservice.     |
| `"scheduler"`  | Scheduled job or cron task.          |
| `"external"`   | Webhook or external caller.          |

```toml
{ identity_kind = "agent" }
```

### `identity_role`

Case-sensitive role membership. Matches if `roles` contains the exact string. There is no `identity_roles` plural and no OR-within-one-condition; for multiple required roles, add one condition per role.

```toml
{ identity_role = "support_agent" }
```

### `identity_id`

Exact match against the principal's `id`.

```toml
{ identity_id = "payment-service" }
```

### `action` and `resource`

Both support trailing wildcards only.

| Pattern    | Strips to | Matches                                          |
| ---------- | --------- | ------------------------------------------------ |
| `"foo"`    | (none)    | Exact: `value == "foo"`.                         |
| `"foo.*"`  | `"foo"`   | `value.starts_with("foo")`.                      |
| `"foo*"`   | `"foo"`   | `value.starts_with("foo")`.                      |

The `.` in `"foo.*"` has no regex or glob meaning; it is consumed as part of the suffix strip. As a consequence `"refund.*"` and `"refund*"` behave identically. Both match `refund`, `refund.create`, `refunds`, and `refunded`. Name your actions so intended prefixes are unambiguous, or use exact matches.

Other glob metacharacters (`?`, `[abc]`, leading `*`, middle `*`) are not supported and match as literals.

`resource` reads `ctx.resource`. If the action has no resource set, the condition is **false** (fails closed).

### `param_max` and `param_min`

Numeric guards. The `field` is a key into `ctx.params`; the value is coerced to `f64`.

| Key          | Inline table                  | Match rule                                                                                |
| ------------ | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `param_max`  | `{ field, max }`              | `params[field] <= max` when present and numeric. **False otherwise** (fail closed).      |
| `param_min`  | `{ field, min }`              | `params[field] >= min` when present and numeric. **False otherwise** (fail closed).      |

Missing or non-numeric fields make the condition false, which means the policy does not match. Default-deny then kicks in unless another policy permits. Do not rely on `param_max` to vacuously permit absent fields.

```toml
{ param_max = { field = "amount", max = 50000.0 } }
{ param_min = { field = "amount", min = 5000.01 } }
```

### `param_in`

String allow-list. `field` is the parameter key; `values` is a list of allowed strings (case sensitive). Missing parameter evaluates to false.

```toml
{ param_in = { field = "currency", values = ["INR", "USD", "EUR"] } }
```

### `rate_limit`

Sliding-window request count. The gate's rate-limit store records every evaluation **before** policies are checked, so `count` is inclusive of the current call. The comparison is `count <= max`, meaning `max = N` allows exactly N calls per window.

| Key      | Type             | Meaning                                                                                |
| -------- | ---------------- | -------------------------------------------------------------------------------------- |
| `max`    | unsigned int     | Maximum matching actions per window.                                                   |
| `window` | duration string  | Sliding-window size. See Duration format below.                                        |

The bucket key is `"{principal_id}:{action_name}"`, so counters are scoped per principal per action.

Fail-closed behavior: if the store returns an error during count, the condition evaluates to false (the policy does not match). If the store fails on `record`, the entire evaluation refuses with `RefuseCode::PolicyDenied`.

```toml
{ rate_limit = { max = 50, window = "24h" } }
```

### `session_age_max`

Maximum session age at evaluation time. Value is a duration string. Sessions older than the value fail; an exactly-equal age passes (`<=`).

Malformed durations silently fall back to **86 400 seconds** (24 hours). Always use explicit, valid durations.

```toml
{ session_age_max = "4h" }
```

### `time_window`

Wall-clock gate. Value is a time-of-day window with an optional IANA timezone suffix. See Time-window format below for the grammar and failure modes.

```toml
{ time_window = "09:00-18:00" }
{ time_window = "09:00-18:00 Asia/Kolkata" }
{ time_window = "22:00-06:00" }
```

## Duration format

| Suffix | Unit    | Example | Seconds |
| ------ | ------- | ------- | ------- |
| `s`    | seconds | `"30s"` | 30      |
| `m`    | minutes | `"5m"`  | 300     |
| `h`    | hours   | `"24h"` | 86 400  |
| `d`    | days    | `"1d"`  | 86 400  |
| (none) | seconds | `"90"`  | 90      |

Rules:

- Numeric portion must parse as a `u64`. Negatives, decimals, and scientific notation are rejected.
- Compound durations (`"1h30m"`, `"2d12h"`, `"90s 30m"`) are not supported and trigger the fallback.
- Leading and trailing whitespace is trimmed.
- On parse failure, `rate_limit` falls back to 3 600 seconds (1 hour) and `session_age_max` falls back to 86 400 seconds (24 hours). Always use explicit valid durations.

## Time-window format

```
window  := "HH:MM-HH:MM" [ WS tz ]
HH      := 00..23
MM      := 00..59
tz      := an IANA identifier, e.g. "Asia/Kolkata", "US/Eastern", "Europe/London"
WS      := any whitespace
```

The separator is a literal hyphen. Hours and minutes are parsed as `%H:%M`; single-digit hours (`"9:00"`) do not parse, always zero-pad.

Semantics:

| Case                                        | Behavior                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| No tz suffix (`"09:00-18:00"`)              | Compared against `evaluated_at` in UTC.                                 |
| With tz (`"09:00-18:00 Asia/Kolkata"`)      | `evaluated_at` is converted to the named tz before comparison.          |
| Same-day window (`start <= end`)            | Matches if `start <= now <= end`. Both endpoints inclusive.             |
| Overnight window (`start > end`)            | Wraps midnight. Matches if `now >= start` OR `now <= end`.              |

Fail-closed inputs (return `false`):

- Missing `-` separator.
- Unparseable start or end.
- Unknown timezone identifier.
- Empty string.

## Evaluation semantics

### Default deny

The engine walks policies in priority order and returns the first match. If no policy matches, the verdict is `Refuse` with `RefuseCode::NoPolicyMatch` and the reason `no policy permits '<action>' for principal '<id>'`. There is no implicit allow; a permit requires a `[[policy]]` whose every condition matches.

### Priority order

Policies are sorted by `priority` ascending at load time. Lower numbers evaluate first. This lets you place narrow `refuse` rules ahead of broad `permit` rules. Priority ties fall back to declaration order.

### First match wins

Once the engine finds a policy whose conditions all evaluate to true, it returns that policy's effect and stops. Later policies are not consulted.

### Condition AND

All conditions inside a policy are ANDed. To express OR, split into multiple `[[policy]]` entries at the same priority.

### Hot reload

`gate.reload(new_toml_string)` accepts a TOML string. On parse error it raises `ValueError` and leaves the previous good set untouched. Reload is atomic; in-flight evaluations finish with their snapshot, subsequent evaluations pick up the new set.

The empty-TOML kill switch:

```python
gate.reload("")  # deny everything
```

## Kitchen-sink example

A single file exercising every condition variant. The same content is also installed at [assets/policies.example.toml](../assets/policies.example.toml).

```toml
# Priority 1: nobody deletes production data outside business hours.
[[policy]]
name = "block_delete_production_after_hours"
description = "Hard gate on destructive prod ops outside 09:00-18:00 IST."
effect = "refuse"
priority = 1
conditions = [
    { action = "delete.*" },
    { resource = "production/*" },
    { time_window = "18:00-09:00 Asia/Kolkata" },
]

# Priority 5: refuse oversized agent refunds before any permit can match.
[[policy]]
name = "agent_block_large_refunds"
effect = "refuse"
priority = 5
conditions = [
    { identity_kind = "agent" },
    { action = "issue_refund" },
    { param_min = { field = "amount", min = 5000.01 } },
]

# Priority 10: small agent refunds, rate-limited, session-capped.
[[policy]]
name = "agent_small_refunds"
description = "AI agents can issue refunds up to INR 5,000."
effect = "permit"
priority = 10
conditions = [
    { identity_kind = "agent" },
    { action = "issue_refund" },
    { param_max = { field = "amount", max = 5000.0 } },
    { param_in = { field = "currency", values = ["INR"] } },
    { rate_limit = { max = 50, window = "24h" } },
    { session_age_max = "4h" },
]

# Priority 20: human support agents, broader limits, business hours only.
[[policy]]
name = "support_refunds"
effect = "permit"
priority = 20
conditions = [
    { identity_role = "support_agent" },
    { action = "issue_refund" },
    { param_max = { field = "amount", max = 50000.0 } },
    { rate_limit = { max = 100, window = "24h" } },
    { time_window = "09:00-18:00 Asia/Kolkata" },
]

# Priority 30: payment-service backend, unbounded (trusted).
[[policy]]
name = "payment_service_refunds"
effect = "permit"
priority = 30
conditions = [
    { identity_kind = "service" },
    { identity_id = "payment-service" },
    { action = "issue_refund" },
]

# Priority 100: catch-all admin allow.
[[policy]]
name = "admin_all_actions"
effect = "permit"
priority = 100
conditions = [
    { identity_role = "admin" },
]
```

Any request that matches none of these five policies is refused by default-deny with `RefuseCode::NoPolicyMatch`.

## Typo protection

Misspelled condition names raise `ValueError` in every loader. This catches the silent class of bug where a misspelled condition (`{"idnetity_kind": "agent"}`) would otherwise be ignored, leaving a more permissive policy than intended.

```python
Gate.from_dict({"policies": [{"name": "p", "effect": "permit", "conditions": [{"idnetity_kind": "agent"}]}]})
# raises ValueError pointing at the bad key
```

The same protection applies at the `[[policy]]` and top-level wrapper layers.
