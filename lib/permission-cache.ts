// In-memory cache of effective permissions per user. A short TTL bounds
// staleness across serverless instances (each instance has its own map);
// the explicit invalidation helpers below give same-instance changes
// immediate effect. Every action that mutates roles, role grants, user
// roles, or overrides MUST call the matching invalidate helper.

const TTL_MS = 60_000;

interface CacheEntry {
  permissions: Set<string>;
  roleNames: string[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getCachedPermissions(userId: string): CacheEntry | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(userId);
    return null;
  }
  return entry;
}

export function setCachedPermissions(
  userId: string,
  permissions: Set<string>,
  roleNames: string[]
): void {
  cache.set(userId, { permissions, roleNames, expiresAt: Date.now() + TTL_MS });
}

// After changing ONE user's roles or overrides.
export function invalidateUserPermissions(userId: string): void {
  cache.delete(userId);
}

// After changing a ROLE's permission grants (affects every holder) or
// deleting a role.
export function invalidateAllPermissions(): void {
  cache.clear();
}
