import { bearer, createApiClient, serviceUrl, unwrap } from "./api-client";
import type { components, paths } from "./generated/chat-service";

export type Channel = components["schemas"]["Channel"];
export type Message = components["schemas"]["Message"];
export type MessagePage = components["schemas"]["MessagePage"];
export type SendMessage = components["schemas"]["SendMessage"];
export const CHAT_SERVICE_URL = serviceUrl(
  process.env.NEXT_PUBLIC_CHAT_SERVICE_URL,
  "http://localhost:3006",
);
const api = createApiClient<paths>(CHAT_SERVICE_URL, {
  notConfiguredMessage:
    "Chat is unavailable: NEXT_PUBLIC_CHAT_SERVICE_URL is missing from this build.",
});
export const getChannel = (token: string, orderId: string, signal?: AbortSignal) =>
  unwrap(
    api.GET("/channels/{orderId}", {
      params: { path: { orderId } },
      headers: bearer(token),
      signal,
    }),
  );
export const listMessages = (
  token: string,
  orderId: string,
  query: { after?: number; before?: number; limit?: number } = {},
  signal?: AbortSignal,
) =>
  unwrap(
    api.GET("/channels/{orderId}/messages", {
      params: { path: { orderId }, query },
      headers: bearer(token),
      signal,
    }),
  );
/** Both a 201 creation and a 200 idempotent replay confirm the outgoing message. */
export const sendMessage = (
  token: string,
  orderId: string,
  body: SendMessage,
  signal?: AbortSignal,
) =>
  unwrap(
    api.POST("/channels/{orderId}/messages", {
      params: { path: { orderId } },
      body,
      headers: bearer(token),
      signal,
    }),
  );
export const markRead = (token: string, orderId: string, seq: number, signal?: AbortSignal) =>
  unwrap(
    api.PUT("/channels/{orderId}/read", {
      params: { path: { orderId } },
      body: { seq },
      headers: bearer(token),
      signal,
    }),
  );
