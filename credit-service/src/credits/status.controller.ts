import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { ServiceKeyGuard } from '../auth/service-key.guard.js';
import { CreditStatusService } from './status.service.js';

/** Read-only recovery surface for Order and approved internal operators. */
@Controller('internal/orders')
@UseGuards(ServiceKeyGuard)
export class CreditStatusController {
  constructor(@Inject(CreditStatusService) private readonly statuses: CreditStatusService) {}

  @Get(':orderId/credit-status')
  status(@Param('orderId') orderId: string) {
    return this.statuses.status(orderId);
  }
}
