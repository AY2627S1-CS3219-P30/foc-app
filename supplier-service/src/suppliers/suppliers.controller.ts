// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 4.8, Claude Opus 5.5), dates: 2026-09-28 to 2026-10-01
// Scope: Generated the initial implementation for "SUP-01: supplier schema, admin CRUD, and
//   idempotent seed" (SUP-01, #187, SUP-02); later new features and bug fixes.
// Author review: Patrick Thomas verified correctness, tested the change, and checked for fatal
//   errors and conflicts with our architecture before committing.

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
  parseIdempotencyKey,
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
    const key = parseIdempotencyKey(idempotencyKey);
    const input = parseOrThrow(supplierCreateSchema, body);
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
