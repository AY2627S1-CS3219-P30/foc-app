import { expect, type APIRequestContext } from "@playwright/test";

/** The stack's mail catcher (compose.yaml): every email the User Service sends lands here. */
const MAILPIT = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";

/**
 * The activation link in the newest email to `email`, as the student would click it. Mail can trail
 * the request that sent it, so this polls. Pass the link already read to wait for a newer one.
 */
export async function activationLink(
  request: APIRequestContext,
  email: string,
  newerThan?: string,
): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const search = await request.get(`${MAILPIT}/api/v1/search`, {
          params: { query: `to:"${email}"`, limit: 1 },
        });
        const id = (await search.json()).messages?.[0]?.ID;
        if (!id) return undefined;
        const text: string = (await (await request.get(`${MAILPIT}/api/v1/message/${id}`)).json()).Text;
        link = text.match(/https?:\/\/\S+\/activate\?token=[\w-]+/)?.[0];
        return link && link !== newerThan ? link : undefined;
      },
      { message: `an activation email for ${email} in Mailpit`, timeout: 15_000 },
    )
    .toBeDefined();
  return link!;
}
