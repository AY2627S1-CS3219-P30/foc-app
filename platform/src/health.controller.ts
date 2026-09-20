import { Controller, Get, Inject } from '@nestjs/common';

export const SERVICE_INFO = Symbol('SERVICE_INFO');

export interface ServiceInfo {
  name: string;
  version: string;
}

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
}

/**
 * PL-NFR1.1.1 — every containerized part reports whether it is healthy.
 *
 * Deliberately dependency-free: it answers as soon as the process can serve
 * traffic. A readiness check that also probes the database belongs in PLT-02,
 * where Compose can act on it.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(SERVICE_INFO) private readonly info: ServiceInfo) {}

  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      service: this.info.name,
      version: this.info.version,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
