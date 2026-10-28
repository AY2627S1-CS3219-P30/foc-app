import { request } from "@playwright/test";
import { ERRAND_STUDENTS, errandEmail, register, RELEASE_STUDENTS, releaseEmail } from "./request-helpers";

/**
 * Registers the errand journey's students once per run, so its projects and retries only sign in.
 * The User Service counts every sign-up attempt, even for an address already taken.
 */
export default async function globalSetup() {
  const api = await request.newContext();
  for (const [who, displayName] of Object.entries(ERRAND_STUDENTS))
    await register(api, errandEmail(who as keyof typeof ERRAND_STUDENTS), displayName);
  if (process.env.E2E_RELEASE === "1")
    for (const [who, displayName] of Object.entries(RELEASE_STUDENTS))
      await register(api, releaseEmail(who as keyof typeof RELEASE_STUDENTS), displayName);
  await api.dispose();
}
