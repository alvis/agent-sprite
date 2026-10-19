/** one projector per key of T; a missing key is a compile error */
export type FieldProjectors<T extends object> = {
  [K in keyof T]-?: (field: Exclude<T[K], undefined>) => unknown;
};

/**
 * projects an object field by field in the value's own key order
 * @param value internal value to project
 * @param map one projector for every key the output contract exposes
 * @returns the output shape, without keys outside the contract or undefined fields
 */
export function projectFields<T extends object, V>(
  value: T,
  map: FieldProjectors<T>,
): V {
  const projectors = new Map<string, (field: never) => unknown>(
    Object.entries<(field: never) => unknown>(map),
  );
  const entries: Array<[string, unknown]> = [];
  for (const [key, field] of Object.entries(value)) {
    const project = projectors.get(key);
    if (project === undefined || field === undefined) {
      continue;
    }
    const projected = project(field as never);
    if (projected !== undefined) {
      entries.push([key, projected]);
    }
  }

  return Object.fromEntries(entries) as V;
}

/**
 * projects a scalar or a leaf whose internal shape is already the output shape
 * @param value field value
 * @returns the same value
 */
export function same<T>(value: T): T {
  return value;
}

/**
 * lifts an item projector to arrays
 * a hole in an observed list is kept as is, so the serializer still encodes it as null
 * @param project projector for one item
 * @returns projector for a list of items
 */
export function each<T, V>(
  project: (item: T) => V,
): (items: readonly T[]) => V[] {
  return (items) =>
    items.map((item) =>
      item === undefined || item === null
        ? (item as unknown as V)
        : project(item),
    );
}

/**
 * lifts a value projector to string-keyed records
 * @param project projector for one record value
 * @returns projector for a whole record, keeping its own key order
 */
export function mapValues<T, V>(
  project: (value: T) => V,
): (record: Readonly<Partial<Record<string, T>>>) => Record<string, V> {
  return (record) =>
    Object.fromEntries(
      Object.entries(record).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, project(value)]],
      ),
    );
}
