import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Authenticated, CurrentUser, type AuthContext } from '@foc/auth-client';
import { ApiException } from '@foc/platform';
import type { Response } from 'express';
import { LiveHub, type LiveSink } from './live-hub.js';

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  // The edge (nginx) would otherwise buffer the stream and deliver nudges in batches.
  'X-Accel-Buffering': 'no',
};

/** A refused page polls, as it always did, and asks again after this long. */
const RETRY_AFTER_S = '60';

/**
 * N1.4 (#329) — `GET /live`, a Server-Sent Events stream of nudges for the caller: `ready` on
 * connect, then `errand` and `board` as errands change (see {@link LiveHub}). The caller is
 * authenticated like every other route, once, when the stream opens; it ends itself after
 * `LIVE_STREAM_MAX_MS`, and the page reconnects with its current token.
 */
@Controller('live')
export class LiveController {
  constructor(@Inject(LiveHub) private readonly hub: LiveHub) {}

  @Get()
  @Authenticated()
  stream(@CurrentUser() caller: AuthContext, @Res() res: Response): void {
    // A browser that left while it was being authenticated has closed the response already, and
    // would hold a stream no one reads until its lifetime ran out.
    if (res.destroyed) return;
    // The status line goes out with the first event, so a refusal can still answer an error. Set
    // one by one, so the request logger can see the stream's content type when it ends.
    const sink: LiveSink = {
      write: (chunk) => {
        if (res.writableEnded || res.destroyed) return;
        if (!res.headersSent) {
          for (const [name, value] of Object.entries(STREAM_HEADERS)) res.setHeader(name, value);
          res.writeHead(200);
        }
        res.write(chunk);
      },
      end: () => void res.end(),
    };
    const opened = this.hub.open(caller.userId, sink);
    if ('refused' in opened) {
      res.setHeader('Retry-After', RETRY_AFTER_S);
      throw opened.refused === 'TOO_MANY_STREAMS'
        ? new ApiException(429, 'TOO_MANY_STREAMS', 'Too many live-update streams are open.')
        : new ApiException(503, 'LIVE_UNAVAILABLE', 'Live updates are unavailable.');
    }
    // The response closes with the connection. The request's own `close` is no use: it fires
    // once its body has been read, which for a GET that sent one is before the stream opens.
    res.on('close', opened.close);
  }
}
