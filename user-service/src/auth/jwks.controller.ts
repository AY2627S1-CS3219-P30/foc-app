import { Controller, Get, Inject } from '@nestjs/common';
import { JWT, type JwtService } from './jwt.service.js';

/** Public keys other services use to verify access tokens without holding any secret. */
@Controller('.well-known')
export class JwksController {
  constructor(@Inject(JWT) private readonly jwt: JwtService) {}

  @Get('jwks.json')
  jwks() {
    return this.jwt.jwks();
  }
}
