export function nowIso(): string {
  return new Date().toISOString();
}

export function newUuid(): string {
  return crypto.randomUUID();
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}
