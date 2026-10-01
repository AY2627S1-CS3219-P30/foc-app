import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import yaml from 'js-yaml';

export const CONTRACTS_DIR = fileURLToPath(new URL('../../contracts/', import.meta.url));

export type ContractName = 'user-service' | 'supplier-service' | 'order-service' | 'credit-service';

export type OpenApiDocument = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, Record<string, unknown>>;
};

export const parseOpenApi = (text: string): OpenApiDocument => yaml.load(text) as OpenApiDocument;

export const loadContract = (name: ContractName): OpenApiDocument =>
  parseOpenApi(readFileSync(`${CONTRACTS_DIR}${name}.openapi.yaml`, 'utf8'));

// ajv-formats is CommonJS; under NodeNext its default export arrives wrapped.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => Ajv2020;

const escapePointer = (segment: string): string =>
  encodeURIComponent(segment.replace(/~/g, '~0').replace(/\//g, '~1'));

/** Follows `#/...` references inside one document. */
export function resolveRef<T = Record<string, unknown>>(doc: unknown, value: unknown): T {
  let current = value as Record<string, unknown> | undefined;
  const seen = new Set<string>();
  while (current && typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) break;
    seen.add(ref);
    current = ref
      .slice(2)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc) as
      Record<string, unknown> | undefined;
  }
  return current as T;
}

export interface ContractResponse {
  status: number;
  body: unknown;
}

/**
 * Validates real provider responses against the published OpenAPI document (provider-side
 * contract check, EI-NFR3.1.1). A response whose status the operation does not document, or whose
 * JSON body does not satisfy the documented schema, fails with every violation listed.
 */
export class ContractValidator {
  private readonly ajv: Ajv2020;
  private readonly cache = new Map<string, ValidateFunction>();
  private static readonly ID = 'contract.json';

  constructor(
    readonly name: string,
    readonly doc: OpenApiDocument,
  ) {
    // OpenAPI 3.1 schemas are JSON Schema 2020-12. Non-strict mode tolerates the
    // OpenAPI-only keywords (`example`, `discriminator`) that sit beside them.
    this.ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
    this.ajv.addSchema(doc as object, ContractValidator.ID);
  }

  static for(name: ContractName): ContractValidator {
    return new ContractValidator(name, loadContract(name));
  }

  /** Returns the violations; empty means the response honours the contract. */
  check(method: string, pathTemplate: string, response: ContractResponse): string[] {
    const where = `${this.name} ${method.toUpperCase()} ${pathTemplate} → ${response.status}`;
    const operation = this.doc.paths[pathTemplate]?.[method.toLowerCase()] as
      { responses?: Record<string, unknown> } | undefined;
    if (!operation) return [`${where}: operation is not in the contract`];

    const responses = operation.responses ?? {};
    const key = [String(response.status), `${String(response.status)[0]}XX`, 'default'].find(
      (candidate) => candidate in responses,
    );
    if (!key) return [`${where}: status is not documented`];

    const documented = resolveRef<{ content?: Record<string, { schema?: unknown }> }>(
      this.doc,
      responses[key],
    );
    const media = documented?.content?.['application/json'];
    if (!media?.schema) {
      return response.body === undefined || response.body === '' || isEmptyObject(response.body)
        ? []
        : [`${where}: contract documents no JSON body`];
    }

    const validate = this.compile(method, pathTemplate, key, documented === responses[key]);
    if (validate(response.body)) return [];
    return (validate.errors ?? []).map(
      (error) => `${where}: ${error.instancePath || '(body)'} ${error.message}`,
    );
  }

  /** Throws with every violation, for use inside a test. */
  assert(method: string, pathTemplate: string, response: ContractResponse): void {
    const violations = this.check(method, pathTemplate, response);
    if (violations.length > 0) throw new Error(violations.join('\n'));
  }

  private compile(method: string, path: string, status: string, inline: boolean): ValidateFunction {
    const cacheKey = `${method} ${path} ${status}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const operationResponse = ['paths', path, method.toLowerCase(), 'responses', status];
    const pointer = inline
      ? [...operationResponse, 'content', 'application/json', 'schema']
      : [
          ...(
            this.doc.paths[path]?.[method.toLowerCase()] as {
              responses: Record<string, { $ref: string }>;
            }
          ).responses[status]!.$ref.slice(2)
            .split('/')
            .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')),
          'content',
          'application/json',
          'schema',
        ];
    const validate = this.ajv.compile({
      $ref: `${ContractValidator.ID}#/${pointer.map(escapePointer).join('/')}`,
    });
    this.cache.set(cacheKey, validate);
    return validate;
  }
}

const isEmptyObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && Object.keys(value).length === 0;
