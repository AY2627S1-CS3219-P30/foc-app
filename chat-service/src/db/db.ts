import type { Db } from '@foc/platform';

/** Chat's own database boundary (ADR 0003). No other service may query it. */
export type ChatDatabase = Db;

export const CHAT_DB = Symbol('CHAT_DB');
