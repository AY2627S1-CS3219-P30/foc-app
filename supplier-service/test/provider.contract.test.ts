import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { ContractValidator } from '@foc/test-harness';
import {
  asAdmin,
  asStudent,
  createTestApp,
  http,
  validSupplier,
  type TestApp,
} from './helpers/app.js';

/**
 * Provider contract check (TST-01, EI-NFR3.1.1): real responses from the running module must
 * satisfy contracts/supplier-service.openapi.yaml.
 */
describe('supplier-service honours its published contract', () => {
  const contract = ContractValidator.for('supplier-service');
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => app.close());

  it('GET /health', async () => {
    contract.assert('get', '/health', await http(app).get('/health'));
  });

  it('POST, GET, PUT and DELETE /suppliers with success and error responses', async () => {
    const created = await http(app)
      .post('/suppliers')
      .set('Authorization', asAdmin)
      .send(validSupplier());
    contract.assert('post', '/suppliers', created);
    contract.assert(
      'post',
      '/suppliers',
      await http(app).post('/suppliers').set('Authorization', asStudent).send(validSupplier()),
    );
    contract.assert(
      'post',
      '/suppliers',
      await http(app).post('/suppliers').set('Authorization', asAdmin).send({}),
    );

    contract.assert(
      'get',
      '/suppliers',
      await http(app).get('/suppliers').set('Authorization', asStudent),
    );
    contract.assert(
      'get',
      '/suppliers',
      await http(app).get('/suppliers?pageSize=0').set('Authorization', asStudent),
    );

    const id = created.body.supplierId as string;
    const one = '/suppliers/{supplierId}';
    contract.assert(
      'get',
      one,
      await http(app).get(`/suppliers/${id}`).set('Authorization', asStudent),
    );
    contract.assert(
      'get',
      one,
      await http(app).get(`/suppliers/${randomUUID()}`).set('Authorization', asStudent),
    );

    const updated = await http(app)
      .put(`/suppliers/${id}`)
      .set('Authorization', asAdmin)
      .set('If-Match', '1')
      .send(validSupplier({ name: 'Renamed' }));
    contract.assert('put', one, updated);
    contract.assert(
      'put',
      one,
      await http(app)
        .put(`/suppliers/${id}`)
        .set('Authorization', asAdmin)
        .set('If-Match', '1')
        .send(validSupplier()),
    );
    contract.assert(
      'delete',
      one,
      await http(app)
        .delete(`/suppliers/${id}`)
        .set('Authorization', asAdmin)
        .set('If-Match', String(updated.body.version)),
    );
  });
});
