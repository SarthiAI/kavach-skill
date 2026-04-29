# SecureChannel

`SecureChannel` is a hybrid-encrypted, post-quantum-signed byte channel between two peers identified by their `KavachKeyPair`s. Each side instantiates a `SecureChannel` with its own keypair and the other side's `PublicKeyBundle`, then exchanges opaque sealed bytes. The channel handles encryption, signing, replay tracking, recipient binding, and context binding. The transport is your problem (HTTP, websocket, queue, file, anything that moves bytes).

This is the right surface when you have two services that need to exchange arbitrary bytes (verdict envelopes, audit-chain segments, sensitive payloads) and you want every message to be:

- Encrypted to the intended recipient (X25519 + ML-KEM-768 hybrid key exchange, ChaCha20-Poly1305 AEAD).
- Signed by the sender (ML-DSA-65, with optional Ed25519 co-signing).
- Bound to a caller-defined context so a message intended for one workflow cannot be replayed into another.
- Bound to a per-message correlation ID so duplicates are detected as replays.
- Bound to the recipient's key, so a sealed envelope sent to peer A cannot be forwarded to peer B and decrypted there (wrong-recipient fails closed at decrypt time).

Every error path is fail-closed. Decryption failures, signature mismatches, replays, wrong-recipient, and wrong-context all raise `ValueError` and surface no plaintext.

## Establishing a channel

Each side constructs its own `SecureChannel` from its full keypair plus the remote side's published bundle.

```python
from kavach import KavachKeyPair, SecureChannel

alice_kp = KavachKeyPair.generate()
bob_kp   = KavachKeyPair.generate()

# Each side ships its public bundle (safe to publish) to the other.
alice_bundle = alice_kp.public_keys()
bob_bundle   = bob_kp.public_keys()

alice_channel = SecureChannel(alice_kp, bob_bundle)
bob_channel   = SecureChannel(bob_kp,   alice_bundle)
```

A `SecureChannel` is symmetric in capability: each side can both send and receive. The instance binds your secret keys to the remote's public keys; if you need to talk to multiple peers, instantiate one channel per peer.

The constructor never reaches the network. Channel establishment is a local hybrid key derivation; the resulting state lives in process memory. Persist the underlying `KavachKeyPair` (via your KMS or sealed storage); the `SecureChannel` itself is cheap to recreate.

Two read-only properties expose the bound key IDs for diagnostics:

```python
alice_channel.local_key_id    # alice's key fingerprint
alice_channel.remote_key_id   # bob's key fingerprint
```

The `remote_key_id` also serves as AEAD additional-authenticated-data on every sealed envelope, so a message accidentally delivered to the wrong recipient fails at decrypt time with a clear error.

## Signed, replay-protected messaging (`send_signed` / `receive_signed`)

This is the surface you almost always want. The sender signs, encrypts, binds a `context_id` and a `correlation_id`; the receiver verifies, decrypts, and rejects replays / wrong-context messages.

```python
sealed = alice_channel.send_signed(
    data=b"settle: order-9876",
    context_id="payment-settlement-v1",
    correlation_id="ord-9876-attempt-1",
)
# `sealed` is opaque bytes, ship it over any transport.

plaintext = bob_channel.receive_signed(
    sealed=sealed,
    expected_context_id="payment-settlement-v1",
)
assert plaintext == b"settle: order-9876"
```

The two binding parameters serve different purposes:

| Parameter         | Role                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `context_id`      | Names the workflow / channel purpose. The receiver must pass the **same** value as `expected_context_id` or decryption raises. Cross-context replay (a settlement message replayed into a refund flow) is blocked. |
| `correlation_id`  | Per-message identifier. The receiver tracks correlation IDs and rejects any repeat, so a captured envelope cannot be redelivered. Use a UUID, an attempt number, or any caller-stable unique value. |

The receiving side raises `ValueError` on any of:

- Decryption failure (wrong recipient, tampered ciphertext).
- Signature mismatch (the bytes were not signed by the bound remote key).
- Replay (this `correlation_id` was already seen on this channel).
- Context mismatch (the `expected_context_id` does not match what the sender bound).

There is no fallback path; on any failure no plaintext is returned and the integrator decides how to log / escalate.

## Encryption-only messaging (`send_data` / `receive_data`)

For payloads where you have integrity and authenticity covered out-of-band (for example, you sign the entire HTTPS request and just need the body encrypted), `send_data` / `receive_data` skip the signature and replay tracking and just encrypt:

```python
sealed = alice_channel.send_data(b"the launch codes")
plaintext = bob_channel.receive_data(sealed)
```

This is faster and produces shorter sealed bytes, but offers no replay protection and no per-message authenticity (the AEAD still authenticates the ciphertext, but anyone who breaks the encryption envelope can re-send it). Default to `send_signed` / `receive_signed` and only drop to `send_data` when you have a specific reason.

## What sealed bytes look like

Sealed bytes are JSON-encoded `EncryptedPayload` envelopes (the FFI uses JSON to keep the Python and Rust sides aligned without a custom wire format). They are opaque to the integrator: do not parse, modify, or assume internal structure. Treat them as "ciphertext blob" and ship them as-is. If you need to embed a sealed envelope in another transport that does not tolerate raw bytes, base64-encode at the transport layer and decode before calling `receive_signed`.

## Operational guidance

- **One channel per peer.** Reuse the channel across messages so the replay cache stays warm. The channel does not free correlation-IDs over time; for very long-lived processes consider rotating to a fresh `SecureChannel` periodically (which also rotates the AEAD key derivation under the hood).
- **Never reuse a `correlation_id` on the same channel.** A duplicate is treated as a replay and rejected. If your transport retries, the retry should pass the same `correlation_id`; the receiver will reject the second arrival, which is the correct behavior.
- **`context_id` is part of the application protocol.** Pick stable, descriptive names (`payment-settlement-v1`, `audit-shipment-2026-q2`) and version them when the message format changes. Two ends of the same workflow must agree on the value.
- **Persist the keypair, not the channel.** Channel state is cheap to rebuild from a `KavachKeyPair` plus the remote `PublicKeyBundle`. Persist the keypair through your KMS; recreate the channel after a restart.

## What `SecureChannel` does not do

- It does not move bytes. You ship the sealed envelope over your transport of choice.
- It does not provide forward secrecy across channel rebuilds. A keypair compromise lets an attacker decrypt past traffic to that keypair. Rotate keypairs (issue a fresh `PublicKeyBundle`, distribute, switch over) when the threat model demands forward secrecy.
- It does not authenticate identity beyond the bound public keys. Whatever process gives you the remote `PublicKeyBundle` (a `PublicKeyDirectory`, a manual exchange, a CA) is the trust root; `SecureChannel` only enforces that messages were signed by *that* key.
