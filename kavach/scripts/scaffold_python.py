#!/usr/bin/env python3
"""Scaffold a minimal Kavach integration for a Python project.

Run from a project root:

    python scaffold_python.py [--target .]

This writes two files into the target directory:

    kavach_setup.py         a starter Gate construction + smoke-test entry point
    kavach_policies.toml    an example TOML policy you can edit

Neither file is overwritten if it already exists; the script aborts with a
non-zero exit code instead. That is intentional: this is a scaffold, not an
upgrade tool.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

SETUP_PY = '''\
"""Kavach integration entry point.

Construct one Gate at process start, reuse it for every action evaluation.
The Gate is thread-safe; a single instance is fine across requests, async
tasks, and worker threads.
"""
from __future__ import annotations

from pathlib import Path

from kavach import ActionContext, Gate, PqTokenSigner

POLICY_PATH = Path(__file__).with_name("kavach_policies.toml")

# Hard caps that beat any permissive policy. Keep these for regulator-grade
# limits that should never be overridden by an admin tweak to policies.toml.
INVARIANTS = [
    ("hard_amount_cap", "amount", 50_000.0),
]

# Optional: sign every Permit verdict with a hybrid (ML-DSA-65 + Ed25519)
# token signer. Downstream services verify tokens without sharing secrets.
# Persist the signer or its keypair through your own KMS; the in-memory
# generator below is for local dev only.
TOKEN_SIGNER = PqTokenSigner.generate_hybrid()


def build_gate() -> Gate:
    """Load policies from kavach_policies.toml and return a configured Gate."""
    return Gate.from_file(
        str(POLICY_PATH),
        invariants=INVARIANTS,
        token_signer=TOKEN_SIGNER,
        # Flip to True to log verdicts without blocking traffic. Read
        # verdict.would_have_been to see what the real gate would have done.
        observe_only=False,
    )


GATE = build_gate()


def evaluate_action(
    *,
    principal_id: str,
    principal_kind: str,
    action_name: str,
    params: dict | None = None,
):
    """Evaluate one action through the gate. Returns the Verdict."""
    ctx = ActionContext(
        principal_id=principal_id,
        principal_kind=principal_kind,
        action_name=action_name,
        params=params or {},
    )
    return GATE.evaluate(ctx)


def smoke_test() -> int:
    """Quick local check that the gate is wired correctly."""
    permit = evaluate_action(
        principal_id="agent-bot",
        principal_kind="agent",
        action_name="issue_refund",
        params={"amount": 500.0},
    )
    print(f"$500 refund: kind={permit.kind} reason={permit.reason}")

    refuse_too_big = evaluate_action(
        principal_id="agent-bot",
        principal_kind="agent",
        action_name="issue_refund",
        params={"amount": 99_999.0},
    )
    print(
        f"$99,999 refund: kind={refuse_too_big.kind} "
        f"evaluator={refuse_too_big.evaluator} reason={refuse_too_big.reason}"
    )

    refuse_no_match = evaluate_action(
        principal_id="agent-bot",
        principal_kind="agent",
        action_name="delete_account",
        params={},
    )
    print(
        f"delete_account: kind={refuse_no_match.kind} "
        f"evaluator={refuse_no_match.evaluator} code={refuse_no_match.code}"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(smoke_test())
'''

POLICIES_TOML = '''\
# Minimal starter policy. Replace with your real rules.
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
'''


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Scaffold a Kavach integration into a Python project."
    )
    parser.add_argument(
        "--target",
        default=".",
        help="Directory to write kavach_setup.py and kavach_policies.toml into. Defaults to the current directory.",
    )
    args = parser.parse_args(argv)

    target = Path(args.target).resolve()
    if not target.is_dir():
        print(f"error: target is not a directory: {target}", file=sys.stderr)
        return 2

    files = {
        target / "kavach_setup.py": SETUP_PY,
        target / "kavach_policies.toml": POLICIES_TOML,
    }

    for path in files:
        if path.exists():
            print(f"error: {path} already exists, refusing to overwrite", file=sys.stderr)
            return 1

    for path, body in files.items():
        path.write_text(body, encoding="utf-8")
        print(f"wrote {path}")

    print()
    print("Next steps:")
    print("  1. pip install kavach-sdk")
    print("  2. Edit kavach_policies.toml with the rules your service needs.")
    print("  3. python kavach_setup.py   # smoke test the gate")
    print("  4. Import GATE and evaluate_action from kavach_setup in your service.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
