# SecureChannel

`SecureChannel` is a hybrid-encrypted, post-quantum-signed byte channel between two peers identified by their `KavachKeyPair`s. Each side instantiates a `SecureChannel` with its own keypair and the other side's `PublicKeyBundleView`, then exchanges opaque sealed bytes. The channel handles encryption, signing, replay tracking, recipient binding, and context binding. The transport is your problem (HTTP, websocket, queue, file, anything that moves bytes).

This is the right surface when you have two services that need to exchange arbitrary bytes (verdict envelopes, audit-chain segments, sensitive payloads) and you want every message to be:

- Encrypted to the intended recipient (X25519 + ML-KEM-768 hybrid key exchange, ChaCha20-Poly1305 AEAD).
- Signed by the sender (ML-DSA-65, with optional Ed25519 co-signing).
- Bound to a caller-defined context so a message intended for one workflow cannot be replayed into another.
- Bound to a per-message correlation ID so duplicates are detected as replays.
- Bound to the recipient's key, so a sealed envelope sent to peer A cannot be forwarded to peer B and decrypted there (wrong-recipient fails closed at decrypt time).

Every error path is fail-closed. Decryption failures, signature mismatches, replays, wrong-recipient, and wrong-context all throw and surface no plaintext.

## Establishing a channel

Each side constructs its own `SecureChannel` from its full keypair plus the remote side's published bundle.

```typescript
import { KavachKeyPair, SecureChannel } from "kavach-sdk";

const aliceKp = KavachKeyPair.generate();
const bobKp   = KavachKeyPair.generate();

// Each side ships its public bundle (safe to publish) to the other.
const aliceBundle = aliceKp.publicKeys();
const bobBundle   = bobKp.publicKeys();

const aliceChannel = new SecureChannel(aliceKp, bobBundle);
const bobChannel   = new SecureChannel(bobKp,   aliceBundle);
```

A `SecureChannel` is symmetric in capability: each side can both send and receive. The instance binds your secret keys to the remote's public keys; if you need to talk to multiple peers, instantiate one channel per peer.

The constructor never reaches the network. Channel establishment is a local hybrid key derivation; the resulting state lives in process memory. Persist the underlying `KavachKeyPair` (via your KMS or sealed storage); the `SecureChannel` itself is cheap to recreate.

Two read-only properties expose the bound key IDs for diagnostics:

```typescript
aliceChannel.localKeyId;    // alice's key fingerprint
aliceChannel.remoteKeyId;   // bob's key fingerprint
```

The `remoteKeyId` also serves as AEAD additional-authenticated-data on every sealed envelope, so a message accidentally delivered to the wrong recipient fails at decrypt time with a clear error.

## Signed, replay-protected messaging (`sendSigned` / `receiveSigned`)

This is the surface you almost always want. The sender signs, encrypts, binds a `contextId` and a `correlationId`; the receiver verifies, decrypts, and rejects replays / wrong-context messages.

```typescript
const sealed = aliceChannel.sendSigned(
  Buffer.from("settle: order-9876", "utf-8"),
  "payment-settlement-v1",   // contextId
  "ord-9876-attempt-1",      // correlationId
);
// `sealed` is opaque bytes (Buffer), ship it over any transport.

const plaintext = bobChannel.receiveSigned(
  sealed,
  "payment-settlement-v1",   // expectedContextId
);
console.assert(plaintext.toString("utf-8") === "settle: order-9876");
```

The two binding parameters serve different purposes:

| Parameter         | Role                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `contextId`       | Names the workflow / channel purpose. The receiver must pass the **same** value as `expectedContextId` or decryption throws. Cross-context replay (a settlement message replayed into a refund flow) is blocked. |
| `correlationId`   | Per-message identifier. The receiver tracks correlation IDs and rejects any repeat, so a captured envelope cannot be redelivered. Use a UUID, an attempt number, or any caller-stable unique value. |

The receiving side throws on any of:

- Decryption failure (wrong recipient, tampered ciphertext).
- Signature mismatch (the bytes were not signed by the bound remote key).
- Replay (this `correlationId` was already seen on this channel).
- Context mismatch (the `expectedContextId` does not match what the sender bound).

There is no fallback path; on any failure no plaintext is returned and the integrator decides how to log / escalate.

## Encryption-only messaging (`sendData` / `receiveData`)

For payloads where you have integrity and authenticity covered out-of-band (for example, you sign the entire HTTPS request and just need the body encrypted), `sendData` / `receiveData` skip the signature and replay tracking and just encrypt:

```typescript
const sealed = aliceChannel.sendData(Buffer.from("the launch codes", "utf-8"));
const plaintext = bobChannel.receiveData(sealed);
```

This is faster and produces shorter sealed bytes, but offers no replay protection and no per-message authenticity (the AEAD still authenticates the ciphertext, but anyone who captures the envelope can resend it). Default to `sendSigned` / `receiveSigned` and only drop to `sendData` when you have a specific reason.

## What sealed bytes look like

Sealed bytes are JSON-encoded `EncryptedPayload` envelopes (the FFI uses JSON to keep the JS and Rust sides aligned without a custom wire format). They are opaque to the integrator: do not parse, modify, or assume internal structure. Treat them as "ciphertext blob" and ship them as-is. If you need to embed a sealed envelope in another transport that does not tolerate raw bytes, base64-encode at the transport layer and decode before calling `receiveSigned`.

## Operational guidance

- **One channel per peer.** Reuse the channel across messages so the replay cache stays warm. The channel does not free correlation-IDs over time; for very long-lived processes consider rotating to a fresh `SecureChannel` periodically (which also rotates the AEAD key derivation under the hood).
- **Never reuse a `correlationId` on the same channel.** A duplicate is treated as a replay and rejected. If your transport retries, the retry should pass the same `correlationId`; the receiver will reject the second arrival, which is the correct behavior.
- **`contextId` is part of the application protocol.** Pick stable, descriptive names (`payment-settlement-v1`, `audit-shipment-2026-q2`) and version them when the message format changes. Two ends of the same workflow must agree on the value.
- **Persist the keypair, not the channel.** Channel state is cheap to rebuild from a `KavachKeyPair` plus the remote `PublicKeyBundleView`. Persist the keypair through your KMS; recreate the channel after a restart.

## What `SecureChannel` does not do

- It does not move bytes. You ship the sealed envelope over your transport of choice.
- It does not provide forward secrecy across channel rebuilds. A keypair compromise lets an attacker decrypt past traffic to that keypair. Rotate keypairs (issue a fresh `PublicKeyBundleView`, distribute, switch over) when the threat model demands forward secrecy.
- It does not authenticate identity beyond the bound public keys. Whatever process gives you the remote `PublicKeyBundleView` (a `PublicKeyDirectory`, a manual exchange, a CA) is the trust root; `SecureChannel` only enforces that messages were signed by *that* key.
