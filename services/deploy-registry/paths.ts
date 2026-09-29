/** Minimal dotted-path get/set for plain JSON config objects, e.g. "retry.baseMs". */

export function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let cursor = obj;
  for (const key of keys) {
    if (typeof cursor[key] !== "object" || cursor[key] === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[last] = value;
}
