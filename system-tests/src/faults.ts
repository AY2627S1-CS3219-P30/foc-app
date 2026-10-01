import type { Db, Queryable } from '@foc/platform';

/**
 * Makes the next transaction on `db` fail when it reaches a statement matching `boundary`, after
 * every earlier write in that transaction has run: a crash at that exact write boundary. The
 * transaction rolls back and the caller (a consumer, a relay, a command) sees an ordinary error.
 */
export function failNextAt(db: Db, boundary: RegExp): { restore(): void; fired(): boolean } {
  const target = db as Db & { transaction: Db['transaction'] };
  const original = target.transaction.bind(target);
  let armed = true;
  target.transaction = (<T>(fn: (tx: Queryable) => Promise<T>) =>
    original((tx) =>
      fn({
        query: async (sql: string, params?: unknown[]) => {
          if (armed && boundary.test(sql)) {
            armed = false;
            throw new Error(`injected crash at ${boundary}`);
          }
          return tx.query(sql, params);
        },
        exec: (sql: string) => tx.exec(sql),
      } as Queryable),
    )) as Db['transaction'];
  return {
    restore: () => {
      target.transaction = original;
    },
    fired: () => !armed,
  };
}
