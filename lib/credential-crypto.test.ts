import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptCredential,
  decryptCredential,
  credentialStoreConfigured,
} from "./credential-crypto";

const HEX_KEY = "a".repeat(64); // 32 bytes

describe("credential-crypto", () => {
  const original = process.env.CREDENTIAL_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = HEX_KEY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = original;
  });

  it("round-trips a value", () => {
    const blob = encryptCredential("Tmp-Pass_123");
    expect(blob).toMatch(/^v1\./);
    expect(decryptCredential(blob)).toBe("Tmp-Pass_123");
  });

  it("uses a fresh IV each call — different ciphertext, same plaintext", () => {
    const a = encryptCredential("x");
    const b = encryptCredential("x");
    expect(a).not.toBe(b);
    expect(decryptCredential(a)).toBe("x");
    expect(decryptCredential(b)).toBe("x");
  });

  it("returns null for a tampered blob", () => {
    const blob = encryptCredential("secret")!;
    expect(decryptCredential(blob.slice(0, -6) + "AAAAAA")).toBeNull();
  });

  it("returns null for junk / wrong prefix / empty / null", () => {
    expect(decryptCredential("")).toBeNull();
    expect(decryptCredential("nope")).toBeNull();
    expect(decryptCredential("v2.abcd")).toBeNull();
    expect(decryptCredential(null)).toBeNull();
    expect(decryptCredential(undefined)).toBeNull();
  });

  it("is a no-op when no key is configured", () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(credentialStoreConfigured()).toBe(false);
    expect(encryptCredential("x")).toBeNull();
    expect(decryptCredential("v1.whatever")).toBeNull();
  });

  it("rejects a wrong-length key", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "abcd";
    expect(credentialStoreConfigured()).toBe(false);
    expect(encryptCredential("x")).toBeNull();
  });

  it("accepts a base64 32-byte key", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    expect(credentialStoreConfigured()).toBe(true);
    const blob = encryptCredential("hello");
    expect(decryptCredential(blob)).toBe("hello");
  });

  it("cannot decrypt a blob produced under a different key", () => {
    const blob = encryptCredential("secret")!;
    process.env.CREDENTIAL_ENCRYPTION_KEY = "b".repeat(64);
    expect(decryptCredential(blob)).toBeNull();
  });
});
