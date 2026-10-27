/** items and projections used to build a record keyed by their derived identities */
export interface RecordFromParams<Item, Key extends string, Value> {
  items: readonly Item[];
  keyOf: (item: Item) => Key;
  valueOf: (item: Item) => Value;
}

/**
 * builds a record with one entry per key, typed by its key union
 * @param keys every key the record must hold
 * @param build derives the value of one key
 * @returns the record keyed by every given key
 */
export function recordOf<Key extends string, Value>(
  keys: readonly Key[],
  build: (key: Key) => Value,
): Record<Key, Value> {
  return recordFrom({ items: keys, keyOf: (key) => key, valueOf: build });
}

/**
 * builds a record with one entry per item, keyed and valued from the item
 * @param params items and functions that derive each entry's key and value
 * @param params.items items to include
 * @param params.keyOf key derived from each item
 * @param params.valueOf value derived from each item
 * @returns the record keyed by every derived key
 */
export function recordFrom<Item, Key extends string, Value>({
  items,
  keyOf,
  valueOf,
}: RecordFromParams<Item, Key, Value>): Record<Key, Value> {
  // every caller derives one entry per key of its closed catalog
  return Object.fromEntries(
    items.map((item): [Key, Value] => [keyOf(item), valueOf(item)]),
  ) as Record<Key, Value>;
}
