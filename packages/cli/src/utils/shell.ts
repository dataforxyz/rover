/**
 * Safely single-quote a value for shell interpolation.
 *
 * Replaces every embedded single-quote with the sequence `'"'"'` so the
 * result can be dropped into a shell command as a single argument.
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
