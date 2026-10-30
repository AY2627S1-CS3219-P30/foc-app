import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Authenticated } from '@foc/auth-client';
import { SuppliersService } from './suppliers.service.js';
import { buildingsQuerySchema, parseOrThrow } from './validation.js';

/**
 * The campus building list (SUP-05), readable by any signed-in, active user.
 * `?inUse=true` narrows it to the buildings with an active supplier.
 */
@Controller('buildings')
export class BuildingsController {
  constructor(@Inject(SuppliersService) private readonly suppliers: SuppliersService) {}

  @Get()
  @Authenticated()
  async list(@Query() query: unknown) {
    const { inUse } = parseOrThrow(buildingsQuerySchema, query);
    return { items: await this.suppliers.buildings(inUse) };
  }
}
