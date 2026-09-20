import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv } from './env.js';

const valid = { SERVICE_NAME: 'user-service', PORT: '3001' };

describe('loadEnv', () => {
  it('accepts a valid environment and coerces PORT to a number', () => {
    const env = loadEnv({}, valid as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(3001);
    expect(env.SERVICE_NAME).toBe('user-service');
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('names every missing variable so a misconfigured container fails loudly', () => {
    expect(() => loadEnv({}, {} as NodeJS.ProcessEnv)).toThrowError(/SERVICE_NAME/);
    expect(() => loadEnv({}, {} as NodeJS.ProcessEnv)).toThrowError(/PORT/);
  });

  it('names a service-specific variable that is missing', () => {
    const schema = { DATABASE_URL: z.string().min(1) };
    expect(() => loadEnv(schema, valid as NodeJS.ProcessEnv)).toThrowError(/DATABASE_URL/);
  });

  it('rejects a PORT outside the valid range', () => {
    const bad = { ...valid, PORT: '99999' };
    expect(() => loadEnv({}, bad as NodeJS.ProcessEnv)).toThrowError(/PORT/);
  });

  it('never includes a variable value in the error message', () => {
    const schema = { JWT_SECRET: z.string().min(32) };
    const bad = { ...valid, JWT_SECRET: 'too-short-secret' };
    expect(() => loadEnv(schema, bad as NodeJS.ProcessEnv)).toThrowError(/JWT_SECRET/);
    expect(() => loadEnv(schema, bad as NodeJS.ProcessEnv)).not.toThrowError(/too-short-secret/);
  });
});
