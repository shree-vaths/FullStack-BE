/**
 * Parses a comma-separated list of origins ("https://a.com, https://b.com").
 * Each must be a bare origin (scheme + host [+ port]); a trailing slash is
 * tolerated, but a path is rejected because browsers never send one in the
 * Origin header, so it could never match. "*" is rejected on purpose: this
 * API should only be callable from known frontends.
 */
export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry === '*') throw new Error('CORS_ORIGINS must list specific origins, not "*"');
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw new Error(`Invalid origin in CORS_ORIGINS: "${entry}"`);
      }
      if (url.pathname !== '/' || url.search || url.hash) {
        throw new Error(
          `CORS_ORIGINS entries must not have a path: "${entry}" (use "${url.origin}")`,
        );
      }
      return url.origin;
    });
}
