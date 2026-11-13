/**
 * JSON Schemas sent to Yandex AI Studio as `response_format: json_schema` with `strict: true`
 * (VL-004B-strict).
 *
 * Observed behaviour of the real API (13.11.2026):
 *  - Accepted: the probe mini-schema and the `extract_offer` schema. Their keywords were `type`,
 *    `properties`, `required`, `additionalProperties: false`, `items`, `enum`, `anyOf` (only `T | null`),
 *    `maxItems`, `maxLength`, `$schema`.
 *  - Rejected (HTTP 400, requestId c16b605321cae768:…): the analyst schema, with «Invalid JSON Schema:
 *    all fields must be required, 'highImpact' is optional». The API validates the schema before
 *    generation and reports the first violation only, so other constructs of that schema (pattern,
 *    format, minItems, propertyNames, const) are UNPROVEN, not proven acceptable.
 *
 * Policy (fail closed):
 *  - Structure must satisfy strict mode: every object lists ALL its properties in `required`, has
 *    `additionalProperties: false`, and is not a dictionary (no `propertyNames` /
 *    `patternProperties` / schema-valued `additionalProperties`). `anyOf` is only `T | null`. No `$ref`,
 *    `allOf`, `oneOf`, `not`.
 *  - Only keywords PROVEN accepted are sent. Validation-only keywords that are unproven (pattern, format,
 *    minLength, minItems, minimum, maximum, …) are stripped from the wire: they are still enforced
 *    locally, because every reply is parsed with the strict Zod schema before use.
 *  - `const` becomes a one-value `enum`; `type: [T, "null"]` becomes the proven `anyOf: [T, null]`.
 *  - Any remaining violation throws before a request is made: no money is spent on a schema the API
 *    would reject.
 */
import { z } from 'zod';
import { InvalidModelOutput } from '../machine/types';

/** Keywords seen in schemas Yandex accepted in strict mode (13.11.2026, raw requests). */
export const PROVEN_STRICT_KEYWORDS = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'maxItems', 'maxLength', 'description']);

/** Validation keywords we may drop from the wire because the local Zod parse enforces them. */
const LOCAL_ONLY_KEYWORDS = new Set(['pattern', 'format', 'minLength', 'minItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'default', 'title', 'examples']);

/** Structural constructs strict mode cannot express or that we have not proven: never sent. */
const FORBIDDEN_KEYWORDS = new Set(['propertyNames', 'patternProperties', '$ref', '$defs', 'definitions', 'allOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'unevaluatedProperties', 'prefixItems', 'contains']);

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => !!x && typeof x === 'object' && !Array.isArray(x);

/** Every reason this schema would be rejected (or is unproven) in strict mode; empty = OK to send. */
export function strictModeViolations(schema: unknown, path = '$'): string[] {
  const out: string[] = [];
  if (!isObj(schema)) return [`${path}: не объект схемы`];
  for (const k of Object.keys(schema)) {
    if (FORBIDDEN_KEYWORDS.has(k)) out.push(`${path}: конструкция «${k}» не поддерживается строгим режимом`);
    else if (!PROVEN_STRICT_KEYWORDS.has(k)) out.push(`${path}: ключевое слово «${k}» не подтверждено для строгого режима Yandex`);
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as unknown[];
    const nonNull = branches.filter((b) => !(isObj(b) && b.type === 'null'));
    if (branches.length !== 2 || nonNull.length !== 1) out.push(`${path}: anyOf допускается только как «T | null»`);
    branches.forEach((b, i) => out.push(...strictModeViolations(b, `${path}.anyOf[${i}]`)));
    return out;
  }
  const type = schema.type;
  if (typeof type !== 'string' || !TYPES.has(type)) out.push(`${path}: нет допустимого «type»`);
  if (type === 'object') {
    const props = isObj(schema.properties) ? schema.properties : null;
    if (!props) out.push(`${path}: объект без «properties» (словари не поддерживаются)`);
    if (schema.additionalProperties !== false) out.push(`${path}: нужно «additionalProperties: false»`);
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    for (const key of Object.keys(props ?? {})) {
      // the exact rule of the 13.11.2026 rejection: «all fields must be required»
      if (!required.has(key)) out.push(`${path}.${key}: all fields must be required — поле «${key}» необязательно`);
      out.push(...strictModeViolations((props as Json)[key], `${path}.${key}`));
    }
    for (const r of required) if (!props || !(r in props)) out.push(`${path}: required «${r}» нет в properties`);
  }
  if (type === 'array') {
    if (!isObj(schema.items)) out.push(`${path}: массив без «items»`);
    else out.push(...strictModeViolations(schema.items, `${path}[]`));
  }
  return out;
}

/** Drop local-only validation keywords and turn `const` into `enum`, recursively. */
function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!isObj(node)) return node;
  // `type: [T, "null"]` → the proven form `anyOf: [{type: T, …}, {type: "null"}]`
  if (Array.isArray(node.type) && node.type.length === 2 && node.type.includes('null')) {
    const t = (node.type as string[]).find((x) => x !== 'null')!;
    const { type: _t, ...rest } = node;
    void _t;
    return { anyOf: [sanitize({ ...rest, type: t }), { type: 'null' }] };
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (LOCAL_ONLY_KEYWORDS.has(k)) continue;
    if (k === 'const') {
      out.enum = [v];
      continue;
    }
    if (k === 'properties' && isObj(v)) out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, sanitize(pv)]));
    else out[k] = sanitize(v);
  }
  return out;
}

/** A code defect, not a model failure — but it must never be sent, and the candidate stays technically incomplete. */
export class StrictSchemaError extends InvalidModelOutput {}

/** The JSON Schema actually sent: sanitized, then verified; throws (no request) if it is not strict-safe. */
export function strictWireJson(wire: z.ZodType, name: string): Json {
  const json = sanitize(z.toJSONSchema(wire, { unrepresentable: 'any' })) as Json;
  const v = strictModeViolations(json);
  if (v.length) throw new StrictSchemaError(`схема ${name} несовместима со строгим режимом (запрос не отправлен): ${v.slice(0, 5).join('; ')}`);
  return json;
}
