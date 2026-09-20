/** Trim, Unicode-normalise and lower-case, so `Alex@U.NUS.edu ` and `alex@u.nus.edu` are one account. */
export function normalizeEmail(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

/** True only for an exact match on an allowed domain — `evil-u.nus.edu` and `u.nus.edu.evil.com` fail. */
export function isAllowedDomain(normalizedEmail: string, allowed: readonly string[]): boolean {
  const at = normalizedEmail.lastIndexOf('@');
  if (at < 1) return false;
  return allowed.includes(normalizedEmail.slice(at + 1));
}
