// In-process per-user order cooldown. Exported so tests can reset it.
export const lastOrderAt = new Map<string, number>();
