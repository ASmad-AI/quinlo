import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hmacHex,
  signToken,
  verifyPassword,
  verifyStripeSignature,
  verifyToken,
} from "./crypto";

describe("passwords", () => {
  test("hash then verify succeeds; wrong password fails; garbage fails", () => {
    const hash = hashPassword("correct horse battery staple");
    assert.equal(verifyPassword("correct horse battery staple", hash), true);
    assert.equal(verifyPassword("wrong", hash), false);
    assert.equal(verifyPassword("x", "not-a-hash"), false);
  });
});

describe("signed tokens", () => {
  test("round-trips, rejects tampering and expiry", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = signToken({ exp, sub: "user_1" }, "secret");
    assert.deepEqual(verifyToken(token, "secret"), { exp, sub: "user_1" });
    assert.equal(verifyToken(`${token}x`, "secret"), null);
    assert.equal(verifyToken(token, "other-secret"), null);
    const expired = signToken({ exp: 1, sub: "user_1" }, "secret");
    assert.equal(verifyToken(expired, "secret"), null);
  });
});

describe("vault (AES-256-GCM)", () => {
  test("encrypt/decrypt round-trips; wrong master key throws; tampering throws", () => {
    const packed = encryptSecret("sk_test_123", "master-key");
    assert.equal(decryptSecret(packed, "master-key"), "sk_test_123");
    assert.throws(() => decryptSecret(packed, "wrong-key"));
    const tampered = `${packed.slice(0, -2)}00`;
    assert.throws(() => decryptSecret(tampered, "master-key"));
    assert.throws(() => decryptSecret("v2$bad", "master-key"));
  });

  test("two encryptions of the same secret differ (random salt/iv)", () => {
    assert.notEqual(encryptSecret("same", "k"), encryptSecret("same", "k"));
  });
});

describe("Stripe-style signature verification", () => {
  const secret = "whsec_test";
  const body = '{"type":"checkout.session.completed"}';
  const t = 1_700_000_000;
  const sig = hmacHex(secret, `${t}.${body}`);
  const header = `t=${t},v1=${sig}`;

  test("valid signature passes", () => {
    assert.equal(verifyStripeSignature(body, header, secret, 300, t), true);
  });

  test("tampered body, stale timestamp, missing header, wrong secret all fail", () => {
    assert.equal(verifyStripeSignature(`${body} `, header, secret, 300, t), false);
    assert.equal(verifyStripeSignature(body, header, secret, 300, t + 301), false);
    assert.equal(verifyStripeSignature(body, undefined, secret, 300, t), false);
    assert.equal(verifyStripeSignature(body, header, "nope", 300, t), false);
    assert.equal(verifyStripeSignature(body, "garbage", secret, 300, t), false);
  });

  test("multiple v1 signatures: any match passes", () => {
    assert.equal(
      verifyStripeSignature(body, `t=${t},v1=deadbeef,v1=${sig}`, secret, 300, t),
      true,
    );
  });
});
