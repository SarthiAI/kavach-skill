# Audit and post-quantum signing

Kavach ships with two cryptographic surfaces a Node integrator can wire in directly:

1. **Signed permit tokens** issued by the gate every time a verdict is a Permit, via `PqTokenSigner`. Downstream services verify each token without sharing key material.
2. **A signed audit chain** that records every action with a tamper-evident hash chain, exportable as JSONL, verifiable by any holder of the public key bundle.

Both use ML-DSA-65 (post-quantum lattice signatures, FIPS 204) with optional hybrid Ed25519 co-signing. The hybrid mode is a downgrade-resistance guard: a hybrid verifier rejects a PQ-only envelope, so an attacker who breaks one algorithm still cannot forge a valid envelope unless they also break the other.

## Generating key material

```typescript
import { KavachKeyPair } from "kavach-sdk";

// Default: no expiry.
const kp = KavachKeyPair.generate();

// Or with a TTL in seconds.
const shortKp = KavachKeyPair.generateWithExpiry(3600);

console.assert(!kp.isExpired);

// Public bundle, safe to ship to verifiers.
const bundle = kp.publicKeys();
```

A `KavachKeyPair` holds the ML-DSA-65 secret key plus an Ed25519 secret key (used in hybrid mode). The secret material lives in process memory and never crosses the FFI boundary as JS-readable bytes. The JS instance has no serialization method.

`bundle` is a `PublicKeyBundleView` with verifying keys for both algorithms. It is safe to publish.

## Signed permit tokens

When a `PqTokenSigner` is attached to a gate, every Permit verdict carries a full signed envelope.

```typescript
import { Gate, PqTokenSigner, type PermitTokenInput } from "kavach-sdk";

const signer = PqTokenSigner.generateHybrid();   // ML-DSA-65 + Ed25519
const gate = Gate.fromObject(policy, { tokenSigner: signer });

const verdict = gate.evaluate(ctx);

if (verdict.isPermit) {
  const pt = verdict.permitToken!;
  // pt.tokenId, pt.evaluationId, pt.issuedAt, pt.expiresAt,
  // pt.actionName, pt.signature
}
```

Downstream verification (no shared secrets, only the public bundle):

```typescript
const reconstructed: PermitTokenInput = {
  tokenId: pt.tokenId,
  evaluationId: pt.evaluationId,
  issuedAt: pt.issuedAt,
  expiresAt: pt.expiresAt,
  actionName: pt.actionName,
};
signer.verify(reconstructed, pt.signature!);   // throws on any failure; returns void on success
```

`PqTokenSigner.verify(token, signature)` returns `void` and throws on any failure (tampering, wrong key, malformed envelope, algorithm mismatch). It does **not** return a boolean.

Sign-failure is fail-closed. If `PqTokenSigner.sign` throws during evaluation, the verdict becomes a Refuse, never a permit-without-signature.

### Constructors

`PqTokenSigner` exposes six static methods. Pick the one that matches how your key material is sourced:

| Constructor                                                                       | When to use                                                                       |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `PqTokenSigner.generatePqOnly(keyId?)`                                            | Quick start / tests; fresh random ML-DSA-65 keypair, no persistence.              |
| `PqTokenSigner.generateHybrid(keyId?)`                                            | Quick start / tests; fresh random ML-DSA-65 + Ed25519 keypair, no persistence.    |
| `PqTokenSigner.fromKeypairPqOnly(keypair, keyId?)`                                | Production: persist a `KavachKeyPair` via your KMS; build a PQ-only signer from it. |
| `PqTokenSigner.fromKeypairHybrid(keypair, keyId?)`                                | Production: persist a `KavachKeyPair`; build a hybrid signer from it.             |
| `PqTokenSigner.pqOnly(mlDsaSigningKey, mlDsaVerifyingKey, keyId)`                 | Low-level: you already hold raw key bytes (e.g. fetched from a remote KMS).       |
| `PqTokenSigner.hybridFromBytes(mlDsaSigningKey, mlDsaVerifyingKey, ed25519SigningKey, ed25519VerifyingKey, keyId)` | Low-level hybrid version.                |

The two `generate*` constructors are convenient but throw the keypair away after construction; use them only when you do not need to verify signatures from anywhere else. The same in-memory signer verifies its own output during the process lifetime, but a restart loses the key.

`keyId` is the identifier stamped into every signed envelope; verifiers use it to look up the matching public bundle in a `PublicKeyDirectory`. When omitted, all `fromKeypair*` and `generate*` constructors default to the keypair's own `id`.

### Persisting keys across process restarts

> **Known limitation in the v0.1.0 release.** The Node `KavachKeyPair` class exposes no serialization of its secret material, there is no `kp.exportSecretBytes()` and no `KavachKeyPair.fromBytes(...)`. So a keypair you generate via `KavachKeyPair.generate()` cannot be persisted through the published Node surface alone. Stable signer identity across process restarts requires one of the two patterns below.

**Pattern B (recommended for v0.1.0): regenerate on every restart and re-distribute the public bundle.** Generate a fresh keypair at boot, build the signer, and push the resulting `PublicKeyBundleView` to your verifier pool through whatever distribution mechanism you already operate (a config service, a Kubernetes ConfigMap, a `PublicKeyDirectory` file, etc.):

```typescript
const kp     = KavachKeyPair.generate();
const signer = PqTokenSigner.fromKeypairHybrid(kp);
const gate   = Gate.fromObject(policy, { tokenSigner: signer });
await distributeToVerifiers(kp.publicKeys());   // your code, e.g. publish to a PublicKeyDirectory
```

Operationally: every gate-process boot generates a new `keyId`. Verifiers must accept multiple bundles in their directory and resolve by the `key_id` stamped on each envelope. Old bundles can be removed once permits issued under them have expired.

**Pattern A (available only with externally-minted keys): provision raw key bytes from your KMS / HSM.** The lowest-level `PqTokenSigner.hybridFromBytes(mlDsaSk, mlDsaVk, edSk, edVk, keyId)` constructor accepts raw `Buffer`s. If your environment can produce ML-DSA-65 and Ed25519 key material outside Kavach (a separate keygen tool, an HSM that exposes ML-DSA-65, etc.), you can route those bytes through your KMS and load them at boot:

```typescript
const mlDsaSk = await myKms.get("kavach/ml_dsa_signing_key");
const mlDsaVk = await myKms.get("kavach/ml_dsa_verifying_key");
const edSk    = await myKms.get("kavach/ed25519_signing_key");
const edVk    = await myKms.get("kavach/ed25519_verifying_key");

const signer = PqTokenSigner.hybridFromBytes(mlDsaSk, mlDsaVk, edSk, edVk, "kavach-prod-2026");
const gate   = Gate.fromObject(policy, { tokenSigner: signer });
```

Do **not** install third-party Node PQ-crypto libraries (`@noble/post-quantum`, `ml-dsa`, etc.) just to mint these bytes for use with Kavach; that path has not been validated to produce keys interoperable with `kavach-pq`'s ML-DSA-65 implementation. The only safe sources are an HSM with native ML-DSA-65 support or a generator that has been verified against `kavach-pq`'s test vectors.

### PQ-only vs hybrid

`signer.isHybrid` (getter, not callable) reports whether a signer signs envelopes with both ML-DSA-65 and Ed25519 (`true`) or ML-DSA-65 only (`false`):

```typescript
if (signer.isHybrid) {
  // signer expects hybrid envelopes
}
```

Algorithm mismatch is strict in both directions. A hybrid verifier rejects a PQ-only envelope (downgrade guard); a PQ-only verifier rejects a hybrid envelope. Pick one mode at deploy time and stick with it; do not mix verifiers.

### Verifying via a public key directory

For multi-service deployments where the verifier has many possible signers, use `PublicKeyDirectory` and `DirectoryTokenVerifier` instead of holding individual `PqTokenSigner` instances.

```typescript
import { writeFileSync } from "node:fs";
import { KavachKeyPair, PublicKeyDirectory, DirectoryTokenVerifier } from "kavach-sdk";

const signingKey = KavachKeyPair.generate();

// Build a root-signed manifest of every public bundle the directory should trust.
const manifest = signingKey.buildSignedManifest([bundleA, bundleB]);
writeFileSync("directory.json", manifest);

// On the verifier side:
const directory = PublicKeyDirectory.fromSignedFile(
  "directory.json",
  signingKey.publicKeys().mlDsaVerifyingKey,
);
const verifier = new DirectoryTokenVerifier(directory, true);

verifier.verify(token, signature);   // throws on tamper / miss / downgrade / expiry
```

`PublicKeyDirectory` has three factories plus several utility surfaces:

| Surface                                                                    | Purpose                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `PublicKeyDirectory.inMemory(bundles?)`                                    | Mutable, in-process directory. Use for tests and dynamic populations.                         |
| `PublicKeyDirectory.fromFile(path)`                                        | Load an unsigned bundle array from disk. No tamper protection.                                |
| `PublicKeyDirectory.fromSignedFile(path, rootMlDsaVerifyingKey)`           | Load a root-signed manifest. The manifest's ML-DSA-65 signature must verify against the supplied root key; anything else throws. **Use this in production.** |
| `PublicKeyDirectory.buildUnsignedManifest(bundles)`                        | Static helper. Returns JSON `Buffer` for `fromFile` consumption.                              |
| `PublicKeyDirectory.buildSignedManifest(bundles, mlDsaSigningKey)`         | Static helper. Returns JSON `Buffer` for `fromSignedFile` consumption. Pass the raw ML-DSA-65 seed bytes; for the keypair-friendly form use `kp.buildSignedManifest(bundles)` (recommended). |
| `directory.fetch(keyId)`                                                   | Look up a single bundle by key id. Throws on miss, backend unavailable, or corrupt manifest.  |
| `directory.insert(bundle)` / `directory.remove(keyId)`                     | Mutate an in-memory directory. Throws on file-backed directories.                             |
| `directory.reload()`                                                       | Re-read the underlying file (file-backed only). Parse / signature errors throw; the previous good cache is preserved. No-op on in-memory directories so callers can be polymorphic. |
| `directory.length` / `directory.isEmpty`                                   | Count diagnostics.                                                                            |

`new DirectoryTokenVerifier(directory, hybrid)` wraps a directory and verifies token signatures by resolving the envelope's `key_id` to a bundle. Its `verify` method has one optional third arg worth knowing about:

```typescript
verifier.verify(token, signature);          // default: rejects an expired bundle (enforceExpiry = true)
verifier.verify(token, signature, false);   // forensic: accept an expired bundle for archive review
```

Default `enforceExpiry: true` is the correct posture for an authorization gate, a rotated-out keypair must not authorise new actions even if its signature is still cryptographically valid. Pass `false` only when re-checking an archived audit trail against a bundle that has since expired; do not weaken it on the live verification path.

Every error path is fail-closed. NotFound, BackendUnavailable, RootSignatureInvalid, Corrupt, EnvelopeParse, AlgorithmMismatch, SignatureInvalid, and (when `enforceExpiry` is true) ExpiredBundle all throw and reject the token cleanly.

## Signed audit chain

`SignedAuditChain` is an append-only, tamper-evident log of `AuditEntry` records.

```typescript
import { KavachKeyPair, AuditEntry, SignedAuditChain } from "kavach-sdk";

const kp = KavachKeyPair.generate();
const chain = new SignedAuditChain(kp, true);          // hybrid = true is the default

const newLength = chain.append(AuditEntry.new(
  "agent-bot",
  "issue_refund",
  "permit",                                            // one of "permit", "refuse", "invalidate"
  "within policy",
));
// newLength is the chain length after the append (number).

chain.verify(kp.publicKeys());                         // throws if anything is tampered
```

Each entry hashes the previous entry, so any single-entry tamper invalidates every entry after it. `verify` walks the chain and validates each signature plus each prev-hash link.

`AuditEntry.new(principalId, actionName, verdict, verdictDetail, options?)` takes four required positional args plus an optional `AuditEntryOptions` object: `{ resource?, decidedBy?, ip?, evaluationId?, sessionId? }`. `verdict` must be exactly `"permit"`, `"refuse"`, or `"invalidate"`; anything else throws. `evaluationId` and `sessionId` must parse as UUIDs when supplied; if you omit them, the SDK fills in fresh random UUIDs.

### Inspecting the chain

| Surface              | Returns                                                        |
| -------------------- | -------------------------------------------------------------- |
| `chain.length`       | Current chain length (number).                                 |
| `chain.isEmpty`      | `true` if the chain has zero entries.                          |
| `chain.headHash`     | Hex SHA-256 of the most recently appended entry. Use for tamper-detection of in-process chains. `"genesis"` for an empty chain. |
| `chain.isHybrid`     | `true` when the chain was constructed with `hybrid = true`.    |

### JSONL export and import

For off-node storage, export to JSONL and verify later:

```typescript
const blob = chain.exportJsonl();                              // Buffer; one SignedAuditEntry per line, trailing newline.
const verifiedCount = SignedAuditChain.verifyJsonl(blob, kp.publicKeys());
// verifiedCount is the number of verified entries (number).
```

Each line is a JSON-encoded `SignedAuditEntry` with this shape (one line shown re-indented for readability; in the file every entry is one line):

```jsonc
{
  "index": 4,
  "previous_hash": "9f2c…ab83",
  "signed_payload": {
    "data": [123, 34, 112, …],        // bytes of the JSON-serialized audit payload (principalId, actionName, verdict, verdictDetail, timestamps, optional fields)
    "ml_dsa_signature": [/* bytes */],
    "ed25519_signature": [/* bytes */, /* present only in hybrid mode */],
    "key_id": "kavach-prod-2026",
    "signed_at": "2026-04-21T10:14:33.512Z",
    "nonce": "f2b7…91"
  },
  "entry_hash": "5e1a…cc44"
}
```

For a tamper-detection test, flipping any byte inside `signed_payload.data` invalidates both the entry hash chain (because `entry_hash` covers the payload) AND the ML-DSA signature in one go, so `verifyJsonl` throws at the first tampered entry. Flipping a byte in `previous_hash` or `entry_hash` directly is equally effective.

`verifyJsonl` infers the chain mode (PQ-only or hybrid) from the blob by default. To assert a specific mode:

```typescript
SignedAuditChain.verifyJsonl(blob, kp.publicKeys(), true);
```

A mismatch between the asserted mode and the actual blob mode throws **before** any cryptography runs, preventing the silent-downgrade attack of verifying a hybrid chain under a PQ-only verifier (or vice versa). Pass `undefined` (or omit) to trust the blob; pass an explicit value when you want a strict assertion.

### Mode-downgrade rejection

The audit chain enforces algorithm mode strictly. A PQ-only verifier on a hybrid chain (the silent-downgrade attack) is rejected. The Rust core inspects every entry and refuses chains where entries disagree on PQ-only vs hybrid (a splice attack).

This is intentionally strict. Do not loosen it; the protection is what makes the audit chain useful for compliance contexts.

## Choosing what to use

| If you need                                                | Use                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Proof that a downstream service should accept this action  | `PqTokenSigner` on the gate, verifier on the receiving service                                  |
| Tamper-evident log of every action                         | `SignedAuditChain` with `verify` after each append, JSONL export for storage                    |
| One verifier that trusts many signers                      | `PublicKeyDirectory` (signed manifest) + `DirectoryTokenVerifier`                               |
| Encrypted, signed, replay-protected bytes between two peers | `SecureChannel`, see [secure-channel.md](secure-channel.md)                                    |

The audit chain is independent of the signed-token surface. Most services want both: signed tokens to authorize each individual action, and a signed audit chain that records every gate call (Permit, Refuse, Invalidate) for incident review and compliance.
