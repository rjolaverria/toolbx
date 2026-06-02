/** Escapes a string for safe use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces every occurrence of each secret value in `text` with `***`. Used before any
 * tool-provided string (e.g. an error message that interpolated an env secret) reaches
 * a log or a returned outcome. Empty/whitespace-only values are ignored so they cannot
 * blanket-redact unrelated text.
 */
export function redactSecrets(text: string, secretValues: readonly string[]): string {
  let result = text;
  for (const value of secretValues) {
    if (value.trim().length === 0) {
      continue;
    }
    result = result.replace(new RegExp(escapeRegExp(value), 'g'), '***');
  }
  return result;
}
