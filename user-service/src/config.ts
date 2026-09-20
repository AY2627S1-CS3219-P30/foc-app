import { loadEnv } from '@foc/platform';

/**
 * The User Service's own required variables, on top of the shared base.
 *
 * Nothing here has a default: a missing value must stop the service at boot
 * rather than silently fall back to something insecure.
 */
export const env = loadEnv({});

export const SERVICE_NAME = 'user-service';
export const SERVICE_VERSION = '0.1.0';
