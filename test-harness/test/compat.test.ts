import { describe, expect, it } from 'vitest';
import {
  findEventBreakingChanges,
  findOpenApiBreakingChanges,
  type OpenApiDocument,
} from '../src/index.js';

const order = {
  type: 'object',
  required: ['orderId', 'status', 'reward'],
  properties: {
    orderId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['OPEN', 'ACCEPTED'] },
    reward: { type: 'integer' },
    note: { type: 'string' },
  },
};

const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['reward'],
  properties: { reward: { type: 'integer' }, zone: { type: 'string', enum: ['A', 'B'] } },
};

const contract = (
  response: Record<string, unknown> = order,
  request: Record<string, unknown> = createBody,
): OpenApiDocument => ({
  openapi: '3.1.0',
  paths: {
    '/orders/{orderId}': {
      parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          '404': { description: 'missing' },
        },
      },
    },
    '/orders': {
      post: {
        requestBody: { required: true, content: { 'application/json': { schema: request } } },
        responses: { '201': { content: { 'application/json': { schema: order } } } },
      },
    },
  },
  components: { schemas: { Order: response } },
});

const clone = <T>(value: T): T => structuredClone(value);

describe('OpenAPI breaking-change detection (EI-NFR3.1.1)', () => {
  it('accepts an identical contract and purely additive changes', () => {
    expect(findOpenApiBreakingChanges(contract(), contract())).toEqual([]);

    const additive = contract(
      { ...order, properties: { ...order.properties, eta: { type: 'string' } } },
      { ...createBody, properties: { ...createBody.properties, hint: { type: 'string' } } },
    );
    additive.paths['/orders/{orderId}/accept'] = { post: { responses: { '200': {} } } };
    expect(findOpenApiBreakingChanges(contract(), additive)).toEqual([]);
  });

  it('fails when a required response field is removed', () => {
    const next = clone(order);
    delete (next.properties as Record<string, unknown>).reward;
    next.required = ['orderId', 'status'];
    expect(findOpenApiBreakingChanges(contract(), contract(next))).toContain(
      'contract GET /orders/{orderId} 200.reward: required field removed',
    );
  });

  it('fails when a required response field becomes optional', () => {
    const next = { ...clone(order), required: ['orderId', 'status'] };
    expect(findOpenApiBreakingChanges(contract(), contract(next))).toContain(
      'contract GET /orders/{orderId} 200.reward: required field made optional',
    );
  });

  it('fails when a field is redefined with another type', () => {
    const next = clone(order);
    next.properties.reward = { type: 'string' } as never;
    expect(findOpenApiBreakingChanges(contract(), contract(next))).toContain(
      'contract GET /orders/{orderId} 200.reward: type changed from integer to string',
    );
  });

  it('fails when a request gains a required field or loses an accepted value', () => {
    const next = {
      ...clone(createBody),
      required: ['reward', 'zone'],
      properties: { reward: { type: 'integer' }, zone: { type: 'string', enum: ['A'] } },
    };
    const changes = findOpenApiBreakingChanges(contract(), contract(order, next));
    expect(changes).toContain('contract POST /orders request.zone: field became required');
    expect(changes).toContain('contract POST /orders request.zone: accepted values removed: B');
  });

  it('fails when an operation or a success response disappears', () => {
    const next = contract();
    delete next.paths['/orders'];
    expect(findOpenApiBreakingChanges(contract(), next)).toContain(
      'contract POST /orders: operation removed',
    );

    const noSuccess = contract();
    (
      noSuccess.paths['/orders/{orderId}']!.get as { responses: Record<string, unknown> }
    ).responses = { '404': {} };
    expect(findOpenApiBreakingChanges(contract(), noSuccess)).toContain(
      'contract GET /orders/{orderId}: response 200 removed',
    );
  });
});

describe('event payload breaking-change detection', () => {
  const events = { 'credit.reserved': clone(order) };

  it('accepts a new optional field and a new event', () => {
    const next = {
      'credit.reserved': {
        ...clone(order),
        properties: { ...order.properties, extra: { type: 'string' } },
      },
      'credit.new-event': { type: 'object' },
    };
    expect(findEventBreakingChanges(events, next)).toEqual([]);
  });

  it('fails on a removed event, a removed or newly required field, or a redefined type', () => {
    expect(findEventBreakingChanges(events, {})).toEqual(['event credit.reserved: removed']);

    const removed = clone(order);
    delete (removed.properties as Record<string, unknown>).reward;
    removed.required = ['orderId', 'status'];
    expect(findEventBreakingChanges(events, { 'credit.reserved': removed })).toContain(
      'event credit.reserved.reward: required field removed',
    );

    const newlyRequired = { ...clone(order), required: [...order.required, 'note'] };
    expect(findEventBreakingChanges(events, { 'credit.reserved': newlyRequired })).toContain(
      'event credit.reserved.note: field became required',
    );

    const redefined = clone(order);
    redefined.properties.orderId = { type: 'integer' } as never;
    expect(findEventBreakingChanges(events, { 'credit.reserved': redefined })).toContain(
      'event credit.reserved.orderId: type changed from string to integer',
    );
  });
});
