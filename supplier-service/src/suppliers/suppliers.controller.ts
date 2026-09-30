import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminOnly, Authenticated } from '@foc/auth-client';
import { SuppliersService } from './suppliers.service.js';
import {
  parseIfMatch,
  parseOrThrow,
  supplierCreateSchema,
  supplierIdSchema,
  supplierListQuerySchema,
  supplierUpdateSchema,
} from './validation.js';

/**
 * The supplier catalogue API (SUP-01).
 *
 * Permissions (enforced server-side, never from a client-claimed role):
 *   - list / view   → any signed-in, active user (`@Authenticated`)
 *   - create / update / deactivate → administrators only (`@AdminOnly`)
 */
@Controller('suppliers')
export class SuppliersController {
  constructor(@Inject(SuppliersService) private readonly suppliers: SuppliersService) {}

  @Get()
  @Authenticated()
  list(@Query() query: unknown) {
    return this.suppliers.list(parseOrThrow(supplierListQuerySchema, query));
  }

  @Get(':id')
  @Authenticated()
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const supplier = await this.suppliers.getById(
      parseOrThrow(supplierIdSchema, id, { fieldName: 'id' }),
    );
    // Set the version ETag explicitly. Without it Express derives a weak
    // content-hash ETag, which the read → If-Match → save flow can't use as a
    // version; POST/PUT set the same header so the shapes match.
    res.setHeader('ETag', `"${supplier.version}"`);
    return supplier;
  }

  @Post()
  @AdminOnly()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseOrThrow(supplierCreateSchema, body);
    const key = idempotencyKey?.trim() || undefined;
    const { supplier, replayed } = await this.suppliers.create(input, key);
    // A replay returns the original supplier with 200; a genuine create is 201.
    res.status(replayed ? 200 : 201);
    res.setHeader('ETag', `"${supplier.version}"`);
    return supplier;
  }

  @Put(':id')
  @AdminOnly()
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const supplierId = parseOrThrow(supplierIdSchema, id, { fieldName: 'id' });
    const version = parseIfMatch(ifMatch);
    const changes = parseOrThrow(supplierUpdateSchema, body);
    const supplier = await this.suppliers.update(supplierId, version, changes);
    res.setHeader('ETag', `"${supplier.version}"`);
    return supplier;
  }

  @Delete(':id')
  @AdminOnly()
  async deactivate(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Deactivation is a versioned write like update: it requires If-Match so a
    // stale view cannot delete a supplier someone else has since changed.
    const supplierId = parseOrThrow(supplierIdSchema, id, { fieldName: 'id' });
    const version = parseIfMatch(ifMatch);
    const supplier = await this.suppliers.deactivate(supplierId, version);
    res.setHeader('ETag', `"${supplier.version}"`);
    return supplier;
  }
}
