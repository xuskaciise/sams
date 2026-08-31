import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// AES-256-GCM at-rest encryption for a lecturer's still-unused,
// admin-issued temporary password (User.pendingCredential). This is the
// ONE deliberate exception to "temp passwords are never persisted" (see
// CLAUDE.md): it's what lets an admin re-send the SAME still-valid
// credential from the PERSISTENT Lecturer Accounts table without
// invalidating it via a password reset. It is never stored as plaintext,
// only ever decrypted server-side to fill an outgoing WhatsApp message,
// and is wiped the moment the lecturer changes their password
// (mustChangePw -> false) or an admin resets it.
//
// Key: process.env.CREDENTIAL_ENCRYPTION_KEY — 32 bytes, given as 64 hex
// chars OR base64. If it's unset or malformed, encryption is a no-op
// (returns null): the column simply stays null, the persistent "Send
// credentials" entry point degrades gracefully (disabled with a hint),
// and the post-generation popup path — which still carries the password
// in memory from the client — is completely unaffected.

const MAGIC = "v1";
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKey(): Buffer | null {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  let key: Buffer;
  try {
    key = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  return key.length === 32 ? key : null;
}

// True when a valid key is configured — i.e. the persistent "Send
// credentials" entry point can actually work.
export function credentialStoreConfigured(): boolean {
  return loadKey() !== null;
}

export function encryptCredential(plain: string): string | null {
  const key = loadKey();
  if (!key) return null;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${MAGIC}.${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

export function decryptCredential(
  blob: string | null | undefined
): string | null {
  if (!blob) return null;
  const key = loadKey();
  if (!key) return null;
  const dot = blob.indexOf(".");
  if (dot < 0 || blob.slice(0, dot) !== MAGIC) return null;
  try {
    const buf = Buffer.from(blob.slice(dot + 1), "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, tampered blob, truncated data — treat as "no credential".
    return null;
  }
}
