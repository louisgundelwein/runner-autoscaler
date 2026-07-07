type Level = 'info' | 'warn' | 'error';

// Structured JSON logs, one line per event. Callers must only pass ids,
// names and counts — never tokens, secrets or JIT configs.
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}
