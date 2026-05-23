#!/usr/bin/env node
/**
 * Scaffold a minimal Kavach integration for a Node / TypeScript project.
 *
 * Run from a project root:
 *
 *     node scaffold.js [--target .]
 *     # or, if running the TS source directly:
 *     ts-node scaffold.ts [--target .]
 *
 * This writes two files into the target directory:
 *
 *     kavach_setup.ts         a starter Gate construction + smoke-test entry point
 *     kavach_policies.toml    an example TOML policy you can edit
 *
 * Neither file is overwritten if it already exists; the script aborts with a
 * non-zero exit code instead. That is intentional: this is a scaffold, not an
 * upgrade tool.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const SETUP_TS = `/**
 * Kavach integration entry point.
 *
 * Construct one Gate at process start, reuse it for every action evaluation.
 * The Gate is thread-safe (the underlying Rust engine is internally synchronised);
 * a single instance is fine across requests, async tasks, and worker threads.
 */

import { resolve } from "node:path";
import {
  Gate,
  PqTokenSigner,
  type EvaluateOptions,
  type Verdict,
} from "kavach-sdk";

const POLICY_PATH = resolve(__dirname, "kavach_policies.toml");

// Hard caps that beat any permissive policy. Keep these for regulator-grade
// limits that should never be overridden by an admin tweak to policies.toml.
const INVARIANTS = [
  { name: "hard_amount_cap", field: "amount", maxValue: 50_000 },
];

// Optional: sign every Permit verdict with a hybrid (ML-DSA-65 + Ed25519)
// token signer. Downstream services verify tokens without sharing secrets.
// Persist the signer or its keypair through your own KMS; the in-memory
// generator below is for local dev only.
const TOKEN_SIGNER = PqTokenSigner.generateHybrid();

function buildGate(): Gate {
  return Gate.fromFile(POLICY_PATH, {
    invariants: INVARIANTS,
    tokenSigner: TOKEN_SIGNER,
    // Flip to true to run the gate without blocking traffic. In observe mode
    // every verdict is a Permit; underlying refuse/invalidate decisions are
    // emitted by the Rust core as tracing INFO logs with the message
    // "observe-only: would have blocked this action". For programmatic
    // visibility, also wire a SignedAuditChain around gate.evaluate(...).
    observeOnly: false,
  });
}

export const GATE = buildGate();

export function evaluateAction(opts: {
  principalId: string;
  principalKind: EvaluateOptions["principalKind"];
  actionName: string;
  params?: Record<string, number | string>;
}): Verdict {
  return GATE.evaluate({
    principalId: opts.principalId,
    principalKind: opts.principalKind,
    actionName: opts.actionName,
    params: opts.params,
  });
}

function smokeTest(): number {
  const permit = evaluateAction({
    principalId: "agent-bot",
    principalKind: "agent",
    actionName: "issue_refund",
    params: { amount: 500 },
  });
  console.log(\`$500 refund: kind=\${permit.kind} reason=\${permit.reason ?? ""}\`);

  const refuseTooBig = evaluateAction({
    principalId: "agent-bot",
    principalKind: "agent",
    actionName: "issue_refund",
    params: { amount: 99_999 },
  });
  console.log(
    \`$99,999 refund: kind=\${refuseTooBig.kind} evaluator=\${refuseTooBig.evaluator ?? ""} reason=\${refuseTooBig.reason ?? ""}\`,
  );

  const refuseNoMatch = evaluateAction({
    principalId: "agent-bot",
    principalKind: "agent",
    actionName: "delete_account",
    params: {},
  });
  console.log(
    \`delete_account: kind=\${refuseNoMatch.kind} evaluator=\${refuseNoMatch.evaluator ?? ""} code=\${refuseNoMatch.code ?? ""}\`,
  );

  return 0;
}

if (require.main === module) {
  process.exit(smokeTest());
}
`;

const POLICIES_TOML = `# Minimal starter policy. Replace with your real rules.
#
# All policies are deny-by-default: an action is refused unless at least one
# permit policy whose conditions all match exists. Refuse policies at lower
# priority numbers run first and short-circuit later permits.
#
# For the full condition grammar, see:
# https://github.com/SarthiAI/kavach-skill/blob/main/kavach/references/policy-language.md

[[policy]]
name = "agent_small_refunds"
description = "AI agents may issue refunds up to $5,000."
effect = "permit"
priority = 10
conditions = [
    { identity_kind = "agent" },
    { action = "issue_refund" },
    { param_max = { field = "amount", max = 5000.0 } },
    { rate_limit = { max = 50, window = "24h" } },
]

[[policy]]
name = "support_refunds"
description = "Human support agents may issue refunds up to $50,000 during business hours."
effect = "permit"
priority = 20
conditions = [
    { identity_role = "support_agent" },
    { action = "issue_refund" },
    { param_max = { field = "amount", max = 50000.0 } },
    { rate_limit = { max = 100, window = "24h" } },
    { time_window = "09:00-18:00 Asia/Kolkata" },
]

[[policy]]
name = "admin_all_actions"
description = "Catch-all admin allow."
effect = "permit"
priority = 100
conditions = [
    { identity_role = "admin" },
]
`;

function parseArgs(argv: string[]): { target: string } {
  let target = ".";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--target") {
      const next = argv[i + 1];
      if (next !== undefined) {
        target = next;
        i++;
      }
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: scaffold.js [--target .]");
      console.log("Writes kavach_setup.ts and kavach_policies.toml into the target directory.");
      process.exit(0);
    }
  }
  return { target };
}

function main(argv: string[]): number {
  const { target } = parseArgs(argv);
  const targetDir = resolve(target);

  let stat;
  try {
    stat = statSync(targetDir);
  } catch {
    console.error(`error: target is not a directory: ${targetDir}`);
    return 2;
  }
  if (!stat.isDirectory()) {
    console.error(`error: target is not a directory: ${targetDir}`);
    return 2;
  }

  const files: Record<string, string> = {
    [join(targetDir, "kavach_setup.ts")]: SETUP_TS,
    [join(targetDir, "kavach_policies.toml")]: POLICIES_TOML,
  };

  for (const path of Object.keys(files)) {
    if (existsSync(path)) {
      console.error(`error: ${path} already exists, refusing to overwrite`);
      return 1;
    }
  }

  for (const [path, body] of Object.entries(files)) {
    writeFileSync(path, body, "utf-8");
    console.log(`wrote ${path}`);
  }

  console.log();
  console.log("Next steps:");
  console.log("  1. npm install kavach-sdk");
  console.log("  2. Edit kavach_policies.toml with the rules your service needs.");
  console.log("  3. tsc kavach_setup.ts && node kavach_setup.js   # smoke test the gate");
  console.log("  4. Import GATE and evaluateAction from kavach_setup in your service.");
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
