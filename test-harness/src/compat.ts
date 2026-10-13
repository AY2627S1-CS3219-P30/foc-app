import { resolveRef, type OpenApiDocument } from './contracts.js';

/**
 * Detects breaking changes between two versions of a wire contract (EI-NFR3.1.1). Within v1
 * contracts are additive only (contracts/README.md), so CI fails on any change that could break
 * an existing producer or consumer:
 *
 * - an operation, response status or event disappears;
 * - a response or event field that was required is removed or becomes optional;
 * - a request or event field becomes newly required;
 * - any field's type is redefined, or a request enum loses a value.
 *
 * Purely additive changes — new operations, optional fields, new events — pass.
 */

type Schema = Record<string, unknown>;
/** `response`: the provider writes and clients read. `request`: clients write and the provider reads. */
type Direction = 'request' | 'response';
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

const types = (schema: Schema | undefined): string[] | undefined => {
  if (!schema) return undefined;
  if (Array.isArray(schema.type)) return [...(schema.type as string[])].sort();
  if (typeof schema.type === 'string') return [schema.type];
  if ('const' in schema) return [typeof schema.const === 'number' ? 'number' : typeof schema.const];
  return undefined;
};

const required = (schema: Schema): Set<string> =>
  new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);

const properties = (schema: Schema): Record<string, Schema> =>
  (schema.properties as Record<string, Schema> | undefined) ?? {};

/** Folds `allOf` members into one object view so their properties compare like any others. */
function flatten(doc: unknown, input: Schema | undefined): Schema | undefined {
  const schema = resolveRef<Schema>(doc, input);
  if (!schema || !Array.isArray(schema.allOf)) return schema;
  const merged: Schema = { ...schema, properties: { ...properties(schema) } };
  const req = required(schema);
  delete merged.allOf;
  for (const part of schema.allOf as Schema[]) {
    const member = flatten(doc, part);
    if (!member) continue;
    Object.assign(merged.properties as Schema, properties(member));
    required(member).forEach((name) => req.add(name));
    if (!merged.type && member.type) merged.type = member.type;
  }
  merged.required = [...req];
  return merged;
}

export function compareSchemas(
  oldDoc: unknown,
  newDoc: unknown,
  oldInput: Schema | undefined,
  newInput: Schema | undefined,
  direction: Direction,
  where: string,
  out: string[],
  depth = 0,
): void {
  if (depth > 25) return; // recursive schemas: deep enough to catch real changes
  const before = flatten(oldDoc, oldInput);
  const after = flatten(newDoc, newInput);
  if (!before) return;
  if (!after) {
    out.push(`${where}: schema removed`);
    return;
  }

  const oldTypes = types(before);
  const newTypes = types(after);
  if (oldTypes && newTypes) {
    // A response may narrow its types and a request may widen them; anything else redefines the field.
    const [from, to] = direction === 'response' ? [newTypes, oldTypes] : [oldTypes, newTypes];
    const allowed = new Set(to);
    if (oldTypes.includes('integer') || oldTypes.includes('number')) allowed.add('integer');
    if (!from.every((t) => allowed.has(t))) {
      out.push(`${where}: type changed from ${oldTypes.join('|')} to ${newTypes.join('|')}`);
      return;
    }
  }

  if (direction === 'request' && Array.isArray(before.enum)) {
    const now = new Set(Array.isArray(after.enum) ? (after.enum as unknown[]) : []);
    const lost = (before.enum as unknown[]).filter((value) => !now.has(value));
    if (Array.isArray(after.enum) && lost.length > 0) {
      out.push(`${where}: accepted values removed: ${lost.map(String).join(', ')}`);
    }
  }

  const oldProps = properties(before);
  const newProps = properties(after);
  const oldRequired = required(before);
  const newRequired = required(after);

  if (direction === 'response') {
    for (const name of oldRequired) {
      if (!(name in newProps)) out.push(`${where}.${name}: required field removed`);
      else if (!newRequired.has(name)) out.push(`${where}.${name}: required field made optional`);
    }
  } else {
    for (const name of newRequired) {
      if (!oldRequired.has(name)) out.push(`${where}.${name}: field became required`);
    }
    if (after.additionalProperties === false) {
      for (const name of Object.keys(oldProps)) {
        if (!(name in newProps)) out.push(`${where}.${name}: accepted field removed`);
      }
    }
  }

  for (const [name, schema] of Object.entries(oldProps)) {
    if (name in newProps) {
      compareSchemas(
        oldDoc,
        newDoc,
        schema,
        newProps[name],
        direction,
        `${where}.${name}`,
        out,
        depth + 1,
      );
    }
  }

  if (before.items || after.items) {
    compareSchemas(
      oldDoc,
      newDoc,
      before.items as Schema,
      after.items as Schema,
      direction,
      `${where}[]`,
      out,
      depth + 1,
    );
  }

  for (const key of ['oneOf', 'anyOf'] as const) {
    const oldBranches = before[key] as Schema[] | undefined;
    const newBranches = after[key] as Schema[] | undefined;
    if (!oldBranches) continue;
    if (!newBranches) {
      out.push(`${where}: ${key} removed`);
      continue;
    }
    // A response that may now return a new shape breaks readers; a request that no longer accepts one breaks writers.
    if (direction === 'response' && newBranches.length > oldBranches.length) {
      out.push(`${where}: ${key} gained a variant`);
    }
    if (direction === 'request' && newBranches.length < oldBranches.length) {
      out.push(`${where}: ${key} lost a variant`);
    }
    oldBranches.forEach((branch, index) => {
      if (newBranches[index]) {
        compareSchemas(
          oldDoc,
          newDoc,
          branch,
          newBranches[index],
          direction,
          `${where}<${key}${index}>`,
          out,
          depth + 1,
        );
      }
    });
  }
}

type Operation = {
  parameters?: Schema[];
  requestBody?: Schema;
  responses?: Record<string, Schema>;
};

const jsonSchemaOf = (doc: unknown, holder: Schema | undefined): Schema | undefined => {
  const resolved = resolveRef<{ content?: Record<string, { schema?: Schema }> }>(doc, holder);
  return resolved?.content?.['application/json']?.schema;
};

export function findOpenApiBreakingChanges(
  oldDoc: OpenApiDocument,
  newDoc: OpenApiDocument,
  label = 'contract',
): string[] {
  const out: string[] = [];
  for (const [path, oldItem] of Object.entries(oldDoc.paths ?? {})) {
    const newItem = newDoc.paths?.[path];
    for (const method of METHODS) {
      const before = oldItem[method] as Operation | undefined;
      if (!before) continue;
      const where = `${label} ${method.toUpperCase()} ${path}`;
      const after = newItem?.[method] as Operation | undefined;
      if (!after) {
        out.push(`${where}: operation removed`);
        continue;
      }

      const params = (op: Operation, doc: unknown) =>
        new Map(
          [...((oldItem.parameters as Schema[]) ?? []), ...(op.parameters ?? [])]
            .map((p) => resolveRef<Schema>(doc, p))
            .map((p) => [`${String(p.in)}:${String(p.name)}`, p] as const),
        );
      const oldParams = params(before, oldDoc);
      const newParams = params(after, newDoc);
      for (const [key, param] of newParams) {
        const previous = oldParams.get(key);
        if (param.required === true && previous?.required !== true) {
          out.push(`${where}: parameter ${key} became required`);
        }
        if (previous) {
          compareSchemas(
            oldDoc,
            newDoc,
            previous.schema as Schema,
            param.schema as Schema,
            'request',
            `${where} parameter ${key}`,
            out,
          );
        }
      }

      const oldBody = resolveRef<Schema>(oldDoc, before.requestBody);
      const newBody = resolveRef<Schema>(newDoc, after.requestBody);
      if (newBody?.required === true && oldBody?.required !== true) {
        out.push(`${where}: request body became required`);
      }
      compareSchemas(
        oldDoc,
        newDoc,
        jsonSchemaOf(oldDoc, oldBody),
        jsonSchemaOf(newDoc, newBody),
        'request',
        `${where} request`,
        out,
      );

      for (const [status, response] of Object.entries(before.responses ?? {})) {
        const replacement = after.responses?.[status];
        if (!replacement) {
          if (status.startsWith('2')) out.push(`${where}: response ${status} removed`);
          continue;
        }
        compareSchemas(
          oldDoc,
          newDoc,
          jsonSchemaOf(oldDoc, response),
          jsonSchemaOf(newDoc, replacement),
          'response',
          `${where} ${status}`,
          out,
        );
      }
    }
  }
  return out;
}

/**
 * Event payloads are written by one service and parsed by others, and both sides of a release can
 * be in flight at once, so every payload is checked in both directions.
 */
export function findEventBreakingChanges(
  oldEvents: Record<string, Schema>,
  newEvents: Record<string, Schema>,
): string[] {
  const out: string[] = [];
  for (const [eventType, schema] of Object.entries(oldEvents)) {
    const next = newEvents[eventType];
    if (!next) {
      out.push(`event ${eventType}: removed`);
      continue;
    }
    compareSchemas(schema, next, schema, next, 'response', `event ${eventType}`, out);
    compareSchemas(schema, next, schema, next, 'request', `event ${eventType}`, out);
  }
  return [...new Set(out)];
}
