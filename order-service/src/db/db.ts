import type { Db } from '@foc/platform';

/** Order's local database boundary. No other service may query this database. */
export type OrderDatabase = Db;

export const ORDER_DB = Symbol('ORDER_DB');
