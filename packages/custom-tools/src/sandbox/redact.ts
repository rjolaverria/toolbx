/** Escapes a string for safe use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces every occurrence of each secret value in `text` with `***`. Used before any
 * tool-provided string (e.g. an error message that interpolated an env secret) reaches
 * a log or a returned outcome. Empty/whitespace-only values are ignored so they cannot
 * blanket-redact unrelated text. Secrets are deduplicated and sorted longest-first so
 * that a longer secret (e.g. `abc123`) is fully redacted before any shorter prefix
 * (e.g. `abc`), preventing partial leaks like `***123`.
 */
export function redactSecrets(text: string, secretValues: readonly string[]): string {
  const ordered = [...new Set(secretValues)]
    .filter((value) => value.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const value of ordered) {
    result = result.replace(new RegExp(escapeRegExp(value), 'g'), '***');
  }
  return result;
}
