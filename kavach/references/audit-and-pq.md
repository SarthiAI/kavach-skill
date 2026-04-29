# Audit and post-quantum signing

Kavach ships with two cryptographic surfaces a Python integrator can wire in directly:

1. **Signed permit tokens** issued by the gate every time a verdict is a Permit, via `PqTokenSigner`. Downstream services verify each token without sharing key material.
2. **A signed audit chain** that records every action with a tamper-evident hash chain, exportable as JSONL, verifiable by any holder of the public key bundle.

Both use ML-DSA-65 (post-quantum lattice signatures, FIPS 204) with optional hybrid Ed25519 co-signing. The hybrid mode is a downgrade-resistance guard: a hybrid verifier rejects a PQ-only envelope, so an attacker who breaks one algorithm still cannot forge a valid envelope unless they also break the other.

## Generating key material

```python
from kavach import KavachKeyPair

# Default: no expiry.
kp = KavachKeyPair.generate()

# Or with a TTL in seconds.
kp = KavachKeyPair.generate_with_expiry(3600)

assert not kp.is_expired

# Public bundle, safe to ship to verifiers.
bundle = kp.public_keys()
```

A `KavachKeyPair` holds the ML-DSA-65 secret key plus an Ed25519 secret key (used in hybrid mode). The secret material never crosses the FFI boundary in plaintext; treat the Python `KavachKeyPair` instance as the secret-bearing object and persist it via your own KMS or sealed storage.

`bundle` is a `PublicKeyBundle` with verifying keys for both algorithms. It is safe to publish.

## Signed permit tokens

When a `PqTokenSigner` is attached to a gate, every Permit verdict carries a full signed envelope.

```python
from kavach import Gate, PqTokenSigner, PermitToken

signer = PqTokenSigner.generate_hybrid()       # ML-DSA-65 + Ed25519
gate = Gate.from_dict(policy, token_signer=signer)

verdict = gate.evaluate(ctx)

if verdict.is_permit:
    pt = verdict.permit_token
    # pt.token_id, pt.evaluation_id, pt.issued_at, pt.expires_at,
    # pt.action_name, pt.signature
```

Downstream verification (no shared secrets, only the public bundle):

```python
reconstructed = PermitToken(
    token_id=pt.token_id,
    evaluation_id=pt.evaluation_id,
    issued_at=pt.issued_at,
    expires_at=pt.expires_at,
    action_name=pt.action_name,
)
assert signer.verify(reconstructed, pt.signature)
```

Sign-failure is fail-closed. If `PqTokenSigner.sign` errors during evaluation, the verdict becomes a Refuse, never a permit-without-signature.

### PQ-only vs hybrid

```python
PqTokenSigner.generate_pq_only()    # ML-DSA-65 only
PqTokenSigner.generate_hybrid()     # ML-DSA-65 + Ed25519
```

Algorithm mismatch is strict in both directions. A hybrid verifier rejects a PQ-only envelope (downgrade guard); a PQ-only verifier rejects a hybrid envelope. Pick one mode at deploy time and stick with it; do not mix verifiers.

`PqTokenSigner` exposes `is_hybrid` as a getter so a verifying service can introspect what it received and refuse mismatches:

```python
if signer.is_hybrid:
    # signer expects hybrid envelopes
    ...
```

### Verifying via a public key directory

For multi-service deployments where the verifier has many possible signers, use `PublicKeyDirectory` and `DirectoryTokenVerifier` instead of holding individual `PqTokenSigner` instances.

```python
from pathlib import Path
from kavach import KavachKeyPair, PublicKeyDirectory, DirectoryTokenVerifier

signing_key = KavachKeyPair.generate()

# Build a root-signed manifest of every public bundle the directory should trust.
manifest = signing_key.build_signed_manifest([bundle_a, bundle_b])
Path("directory.json").write_bytes(manifest)

# On the verifier side:
directory = PublicKeyDirectory.from_signed_file(
    "directory.json",
    root_ml_dsa_verifying_key=signing_key.public_keys().ml_dsa_verifying_key,
)
verifier = DirectoryTokenVerifier(directory, hybrid=True)

verifier.verify(token, signed_envelope)  # raises on tamper, miss, or downgrade
```

`PublicKeyDirectory` has three factories: `in_memory([...])`, `from_file(path)`, and `from_signed_file(path, root_ml_dsa_verifying_key=...)`. The signed-file variant is the one to use in production, the manifest is signed by a single root key and any tamper raises on load.

`insert` and `remove` work only on the in-memory variant; calling them on a file-backed directory raises. `reload` on the in-memory variant is a no-op (not an error), so callers can be polymorphic.

Every error path is fail-closed. NotFound, BackendUnavailable, RootSignatureInvalid, Corrupt, EnvelopeParse, AlgorithmMismatch, and SignatureInvalid all reject the token cleanly.

## Signed audit chain

`SignedAuditChain` is an append-only, tamper-evident log of `AuditEntry` records.

```python
from kavach import KavachKeyPair, AuditEntry, SignedAuditChain

kp = KavachKeyPair.generate()
chain = SignedAuditChain(kp, hybrid=True)

chain.append(AuditEntry(
    principal_id="agent-bot",
    action_name="issue_refund",
    verdict="permit",
    verdict_detail="within policy",
))

chain.verify(kp.public_keys())  # raises if anything is tampered
```

Each entry hashes the previous entry, so any single-entry tamper invalidates every entry after it. `verify` walks the chain and validates each signature plus each prev-hash link.

### JSONL export and import

For off-node storage, export to JSONL and verify later:

```python
blob = chain.export_jsonl()
SignedAuditChain.verify_jsonl(blob, kp.public_keys())
```

`verify_jsonl` infers the chain mode (PQ-only or hybrid) from the blob by default. To assert a specific mode:

```python
SignedAuditChain.verify_jsonl(blob, kp.public_keys(), hybrid=True)
```

A mismatch between the asserted mode and the actual blob mode raises before any cryptography runs.

### Mode-downgrade rejection

The audit chain enforces algorithm mode strictly. A PQ-only verifier on a hybrid chain (the silent-downgrade attack) is rejected with `AuditChainBroken`. The Rust core inspects every entry and refuses chains where entries disagree on PQ-only vs hybrid (a splice attack).

This is intentionally strict. Do not loosen it; the protection is what makes the audit chain useful for compliance contexts.

## Choosing what to use

| If you need                                                | Use                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| Proof that a downstream service should accept this action  | `PqTokenSigner` on the gate, verifier on the receiving service |
| Tamper-evident log of every action                         | `SignedAuditChain` with `verify` after each append, JSONL export for storage |
| One verifier that trusts many signers                      | `PublicKeyDirectory` (signed manifest) + `DirectoryTokenVerifier` |
| Encrypted bytes between two known peers                    | `SecureChannel` (see the [Python SDK README](https://github.com/SarthiAI/Kavach/blob/main/kavach-py/README.md) for details) |

The audit chain is independent of the signed-token surface. Most services want both: signed tokens to authorize each individual action, and a signed audit chain that records every gate call (Permit, Refuse, Invalidate) for incident review and compliance.
