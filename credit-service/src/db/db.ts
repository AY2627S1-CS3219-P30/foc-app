import type { DrizzleDatabase } from '@foc/platform';
import type * as schema from './schema.js';

export type Database = DrizzleDatabase<typeof schema>;

export const DB = Symbol('CREDIT_DB');
export const RAW_DB = Symbol('CREDIT_RAW_DB');
