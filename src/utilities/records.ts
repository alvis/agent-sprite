/**
 * builds a record with one entry per key, typed by its key union
 * @param keys every key the record must hold
 * @param build derives the value of one key
 * @returns the record keyed by every given key
 * @throws {Error} when an entry is missing, which the build loop never allows
 */
export function recordOf<Key extends string, Value>(
  keys: readonly Key[],
  build: (key: Key) => Value,
): Record<Key, Value> {
  return recordFrom(keys, (key) => key, build);
}

/**
 * builds a record with one entry per item, keyed and valued from the item
 * @param items every item the record must hold an entry for
 * @param keyOf derives the key of one item
 * @param valueOf derives the value of one item
 * @returns the record keyed by every derived key
 * @throws {Error} when an entry is missing, which the build loop never allows
 */
export function recordFrom<Item, Key extends string, Value>(
  items: readonly Item[],
  keyOf: (item: Item) => Key,
  valueOf: (item: Item) => Value,
): Record<Key, Value> {
  const keys: Key[] = [];
  const record: Partial<Record<Key, Value>> = {};
  for (const item of items) {
    const key = keyOf(item);
    keys.push(key);
    record[key] = valueOf(item);
  }
  if (!hasEveryKey(record, keys)) {
    throw new Error(`Record is missing one of: ${keys.join(', ')}`);
  }

  return record;
}

/**
 * narrows a partial record once every key is present
 * @param record record built from the keys
 * @param keys every key the record must hold
 * @returns whether the record holds every key
 */
function hasEveryKey<Key extends string, Value>(
  record: Partial<Record<Key, Value>>,
  keys: readonly Key[],
): record is Record<Key, Value> {
  return keys.every((key) => Object.hasOwn(record, key));
}
