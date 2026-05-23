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

A `KavachKeyPair` holds the ML-DSA-65 secret key plus an Ed25519 secret key (used in hybrid mode). The secret material lives in process memory and never crosses the FFI boundary as Python-readable bytes, the Python instance has no serialization method. For stable signer identity across process restarts, see "Persisting keys across process restarts" below; the practical pattern is to provision raw key bytes from your KMS / HSM at boot and skip `KavachKeyPair` entirely.

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
signer.verify(reconstructed, pt.signature)   # raises ValueError on any failure; returns None on success
```

`PqTokenSigner.verify(token, signature)` returns `None` and raises `ValueError` on any failure (tampering, wrong key, malformed envelope, algorithm mismatch). It does **not** return a boolean, do not write `assert signer.verify(...)`.

Sign-failure is fail-closed. If `PqTokenSigner.sign` errors during evaluation, the verdict becomes a Refuse, never a permit-without-signature.

### Constructors

`PqTokenSigner` exposes six class methods. Pick the one that matches how your key material is sourced:

| Constructor                                                                   | When to use                                                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `PqTokenSigner.generate_pq_only(key_id=None)`                                 | Quick start / tests; fresh random ML-DSA-65 keypair, no persistence.              |
| `PqTokenSigner.generate_hybrid(key_id=None)`                                  | Quick start / tests; fresh random ML-DSA-65 + Ed25519 keypair, no persistence.    |
| `PqTokenSigner.from_keypair_pq_only(keypair, key_id=None)`                    | Production: persist a `KavachKeyPair` via your KMS; build a PQ-only signer from it. |
| `PqTokenSigner.from_keypair_hybrid(keypair, key_id=None)`                     | Production: persist a `KavachKeyPair`; build a hybrid signer from it.             |
| `PqTokenSigner.pq_only(ml_dsa_signing_key, ml_dsa_verifying_key, key_id)`     | Low-level: you already hold raw key bytes (e.g. fetched from a remote KMS).       |
| `PqTokenSigner.hybrid(ml_dsa_signing_key, ml_dsa_verifying_key, ed25519_signing_key, ed25519_verifying_key, key_id)` | Low-level hybrid version.            |

The two `generate_*` constructors are convenient but throw the keypair away after construction; use them only when you do not need to verify signatures from anywhere else. The same in-memory signer verifies its own output during the process lifetime, but a restart loses the key.

`key_id` is the identifier stamped into every signed envelope; verifiers use it to look up the matching public bundle in a `PublicKeyDirectory`. When omitted, all `from_keypair_*` and `generate_*` constructors default to the keypair's own `id`.

### Persisting keys across process restarts

> **Known limitation in v0.1.0 of `kavach-sdk`.** The Python `KavachKeyPair` class exposes no serialization of its secret material, there is no `kp.export_secret_bytes()` and no `KavachKeyPair.from_bytes(...)`. So a keypair you generate via `KavachKeyPair.generate()` cannot be persisted through the published Python surface alone. Stable signer identity across process restarts requires one of the two patterns below, with the limitations noted on each. Tracked on the upstream Kavach roadmap.

**Pattern B (recommended for v0.1.0): regenerate on every restart and re-distribute the public bundle.** The only path that is fully reachable through the published Python SDK on its own. Generate a fresh keypair at boot, build the signer, and push the resulting `PublicKeyBundle` to your verifier pool through whatever distribution mechanism you already operate (a config service, a Kubernetes ConfigMap, a `PublicKeyDirectory` file, etc.):

```python
kp     = KavachKeyPair.generate()
signer = PqTokenSigner.from_keypair_hybrid(kp)
gate   = Gate.from_dict(policy, token_signer=signer)
distribute_to_verifiers(kp.public_keys())   # your code, e.g. publish to a PublicKeyDirectory
```

Operationally: every gate-process boot generates a new `key_id`. Verifiers must accept multiple bundles in their directory and resolve by the `key_id` stamped on each envelope. Old bundles can be removed once permits issued under them have expired.

This pattern is acceptable for single-tenant deployments and for any deployment where verifiers can be updated within seconds of a gate-process restart. It is not suitable when verifiers are eventually consistent or operated by a third party who cannot re-fetch the bundle on demand.

**Pattern A (available only with externally-minted keys): provision raw key bytes from your KMS / HSM.** The lowest-level `PqTokenSigner.hybrid(ml_dsa_sk, ml_dsa_vk, ed_sk, ed_vk, key_id=...)` constructor accepts raw bytes. If your environment can produce ML-DSA-65 and Ed25519 key material outside Kavach (a separate keygen tool, an HSM that exposes ML-DSA-65, etc.), you can route those bytes through your KMS and load them at boot:

```python
ml_dsa_sk = my_kms.get("kavach/ml_dsa_signing_key")     # 32-byte ML-DSA-65 seed
ml_dsa_vk = my_kms.get("kavach/ml_dsa_verifying_key")   # encoded ML-DSA-65 verifying key
ed_sk     = my_kms.get("kavach/ed25519_signing_key")
ed_vk     = my_kms.get("kavach/ed25519_verifying_key")

signer = PqTokenSigner.hybrid(ml_dsa_sk, ml_dsa_vk, ed_sk, ed_vk, key_id="kavach-prod-2026")
gate   = Gate.from_dict(policy, token_signer=signer)
```

This pattern gives you stable identity across restarts, but it presumes you have a non-Kavach path that emits matching ML-DSA-65 / Ed25519 key bytes. Do **not** install third-party Python PQ-crypto libraries (`pqcrypto`, `ml-dsa`, `pyca/cryptography`, etc.) just to mint these bytes for use with Kavach, that path has not been validated to produce keys interoperable with `kavach-pq`'s ML-DSA-65 implementation. The only safe sources are an HSM with native ML-DSA-65 support or a generator that has been verified against `kavach-pq`'s test vectors.

**Picking between them:** for v0.1.0, default to Pattern B and live with the rotate-per-restart operational cost. Pattern A becomes attractive only when (a) you have an HSM-backed ML-DSA-65 generator and (b) the operational cost of bundle redistribution is high enough to justify the complexity. The upstream roadmap tracks adding `KavachKeyPair` serialization, which would make Pattern A reachable end-to-end through the SDK alone, watch for that on the roadmap.

### PQ-only vs hybrid

`PqTokenSigner.is_hybrid` (property, not callable) reports whether a signer signs envelopes with both ML-DSA-65 and Ed25519 (`True`) or ML-DSA-65 only (`False`):

```python
if signer.is_hybrid:
    # signer expects hybrid envelopes
    ...
```

Algorithm mismatch is strict in both directions. A hybrid verifier rejects a PQ-only envelope (downgrade guard); a PQ-only verifier rejects a hybrid envelope. Pick one mode at deploy time and stick with it; do not mix verifiers.

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
    signing_key.public_keys().ml_dsa_verifying_key,
)
verifier = DirectoryTokenVerifier(directory, hybrid=True)

verifier.verify(token, signature)            # raises ValueError on tamper / miss / downgrade / expiry
```

`PublicKeyDirectory` has three factories plus several utility surfaces:

| Surface                                                                    | Purpose                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `PublicKeyDirectory.in_memory(bundles=[])`                                 | Mutable, in-process directory. Use for tests and dynamic populations.                         |
| `PublicKeyDirectory.from_file(path)`                                       | Load an unsigned bundle array from disk. No tamper protection.                                |
| `PublicKeyDirectory.from_signed_file(path, root_ml_dsa_verifying_key)`     | Load a root-signed manifest. The manifest's ML-DSA-65 signature must verify against the supplied root key; anything else raises. **Use this in production.** |
| `PublicKeyDirectory.build_unsigned_manifest(bundles)`                      | Static helper. Returns JSON bytes for `from_file` consumption.                                |
| `PublicKeyDirectory.build_signed_manifest(bundles, ml_dsa_signing_key)`    | Static helper. Returns JSON bytes for `from_signed_file` consumption. Pass the raw ML-DSA-65 seed bytes; for the keypair-friendly form use `KavachKeyPair.build_signed_manifest(bundles)` (recommended). |
| `directory.fetch(key_id)`                                                  | Look up a single bundle by key id. Raises on miss, backend unavailable, or corrupt manifest.  |
| `directory.insert(bundle)` / `directory.remove(key_id)`                    | Mutate an in-memory directory. Raises on file-backed directories.                             |
| `directory.reload()`                                                       | Re-read the underlying file (file-backed only). Parse / signature errors raise; the previous good cache is preserved. No-op on in-memory directories so callers can be polymorphic. |
| `len(directory)` / `directory.length` / `directory.is_empty`               | Count diagnostics.                                                                            |

`DirectoryTokenVerifier(directory, hybrid=True)` wraps a directory and verifies token signatures by resolving the envelope's `key_id` to a bundle. Its `verify` method has one keyword-only kwarg worth knowing about:

```python
verifier.verify(token, signature, enforce_expiry=True)   # default: rejects an expired bundle
verifier.verify(token, signature, enforce_expiry=False)  # forensic: accept an expired bundle for archive review
```

Default `enforce_expiry=True` is the correct posture for an authorization gate, a rotated-out keypair must not authorise new actions even if its signature is still cryptographically valid. Pass `enforce_expiry=False` only when re-checking an archived audit trail against a bundle that has since expired; do not weaken it on the live verification path.

Every error path is fail-closed. NotFound, BackendUnavailable, RootSignatureInvalid, Corrupt, EnvelopeParse, AlgorithmMismatch, SignatureInvalid, and (when `enforce_expiry=True`) ExpiredBundle all raise `ValueError` and reject the token cleanly.

## Signed audit chain

`SignedAuditChain` is an append-only, tamper-evident log of `AuditEntry` records.

```python
from kavach import KavachKeyPair, AuditEntry, SignedAuditChain

kp = KavachKeyPair.generate()
chain = SignedAuditChain(kp, hybrid=True)             # hybrid=True is the default

new_length = chain.append(AuditEntry(
    principal_id="agent-bot",
    action_name="issue_refund",
    verdict="permit",                                  # one of "permit", "refuse", "invalidate"
    verdict_detail="within policy",
))
# new_length is the chain length after the append (returns u64).

chain.verify(kp.public_keys())                         # raises ValueError if anything is tampered
```

Each entry hashes the previous entry, so any single-entry tamper invalidates every entry after it. `verify` walks the chain and validates each signature plus each prev-hash link.

`AuditEntry` accepts these constructor kwargs (all positional-or-keyword): `principal_id`, `action_name`, `verdict`, `verdict_detail` (required), plus `resource`, `decided_by`, `ip`, `evaluation_id`, `session_id` (optional). `verdict` must be exactly `"permit"`, `"refuse"`, or `"invalidate"`; anything else raises. `evaluation_id` and `session_id` must parse as UUIDs when supplied; if you omit them, the SDK fills in fresh random UUIDs.

### Inspecting the chain

| Surface              | Returns                                                        |
| -------------------- | -------------------------------------------------------------- |
| `len(chain)`         | Current chain length (`int`).                                  |
| `chain.length`       | Same value; convenient for chained property access.            |
| `chain.is_empty`     | `True` if the chain has zero entries.                          |
| `chain.head_hash`    | Hex SHA-256 of the most recently appended entry. Use for tamper-detection of in-process chains. |
| `chain.is_hybrid`    | `True` when the chain was constructed with `hybrid=True`.      |

### JSONL export and import

For off-node storage, export to JSONL and verify later:

```python
blob = chain.export_jsonl()                    # bytes; one SignedAuditEntry per line, trailing newline.
verified_count = SignedAuditChain.verify_jsonl(blob, kp.public_keys())
# verified_count is the number of verified entries (int).
```

`verify_jsonl` infers the chain mode (PQ-only or hybrid) from the blob by default. To assert a specific mode:

```python
SignedAuditChain.verify_jsonl(blob, kp.public_keys(), hybrid=True)
```

A mismatch between the asserted mode and the actual blob mode raises `ValueError` **before** any cryptography runs, preventing the silent-downgrade attack of verifying a hybrid chain under a PQ-only verifier (or vice versa). Pass `hybrid=None` (the default) to trust the blob; pass an explicit value when you want a strict assertion.

### Mode-downgrade rejection

The audit chain enforces algorithm mode strictly. A PQ-only verifier on a hybrid chain (the silent-downgrade attack) is rejected with `AuditChainBroken`. The Rust core inspects every entry and refuses chains where entries disagree on PQ-only vs hybrid (a splice attack).

This is intentionally strict. Do not loosen it; the protection is what makes the audit chain useful for compliance contexts.

## Choosing what to use

| If you need                                                | Use                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| Proof that a downstream service should accept this action  | `PqTokenSigner` on the gate, verifier on the receiving service |
| Tamper-evident log of every action                         | `SignedAuditChain` with `verify` after each append, JSONL export for storage |
| One verifier that trusts many signers                      | `PublicKeyDirectory` (signed manifest) + `DirectoryTokenVerifier` |
| Encrypted, signed, replay-protected bytes between two peers | `SecureChannel`, see [secure-channel.md](secure-channel.md)  |

The audit chain is independent of the signed-token surface. Most services want both: signed tokens to authorize each individual action, and a signed audit chain that records every gate call (Permit, Refuse, Invalidate) for incident review and compliance.
