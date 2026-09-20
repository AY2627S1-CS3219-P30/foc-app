import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UsersService } from './users.service.js';
import { activateSchema, parseOrThrow, registerSchema } from './validation.js';

const correlationOf = (req: Request): string =>
  (req as Request & { correlationId?: string }).correlationId ?? 'unknown';

@Controller('auth')
export class AuthController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Post('register')
  @HttpCode(201)
  register(@Body() body: unknown) {
    return this.users.register(parseOrThrow(registerSchema, body));
  }

  @Post('activate')
  @HttpCode(200)
  activate(@Body() body: unknown, @Req() req: Request) {
    const { token } = parseOrThrow(activateSchema, body);
    return this.users.activate(token, correlationOf(req));
  }
}
