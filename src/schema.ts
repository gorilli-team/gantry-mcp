/*
 * Standard Schema helpers. Gantry adds its reserved arguments
 * (`_approvalToken`, `_idempotencyKey`) to a tool's input schema by wrapping
 * the user's schema, so it works with any Standard Schema library (Zod 4,
 * Valibot, ArkType) without depending on one.
 */

type Issue = { message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> };
type ValidateResult = { value: unknown; issues?: undefined } | { issues: ReadonlyArray<Issue> };
type JsonConverter = {
  input(o: unknown): Record<string, unknown>;
  output(o: unknown): Record<string, unknown>;
};

export interface StandardLike {
  "~standard": {
    version: 1;
    vendor: string;
    validate(value: unknown): ValidateResult | Promise<ValidateResult>;
    jsonSchema?: JsonConverter;
  };
}

export function isStandardSchema(value: unknown): value is StandardLike {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as StandardLike)["~standard"]?.validate === "function"
  );
}

/** A plain `{ field: schema }` record of Standard Schemas (the SDK's "raw shape"). */
export function isRawShape(value: unknown): value is Record<string, StandardLike> {
  if (!value || typeof value !== "object" || isStandardSchema(value)) return false;
  const values = Object.values(value);
  return values.length > 0 && values.every(isStandardSchema);
}

/** Holds the reserved values extracted for a validated args object. */
export const reservedValues = new WeakMap<object, Record<string, unknown>>();

const validateField = async (schema: StandardLike, value: unknown) =>
  schema["~standard"].validate(value);

/** Builds an object Standard Schema from a raw shape. */
function objectFromShape(shape: Record<string, StandardLike>): StandardLike {
  return {
    "~standard": {
      version: 1,
      vendor: "gantry",
      async validate(input) {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return { issues: [{ message: "Expected an object" }] };
        }
        const out: Record<string, unknown> = {};
        const issues: Issue[] = [];
        for (const [key, schema] of Object.entries(shape)) {
          const raw = (input as Record<string, unknown>)[key];
          const res = await validateField(schema, raw);
          if (res.issues) {
            for (const issue of res.issues)
              issues.push({ ...issue, path: [key, ...(issue.path ?? [])] });
          } else if (res.value !== undefined || key in input) {
            out[key] = res.value;
          }
        }
        return issues.length ? { issues } : { value: out };
      },
      jsonSchema: {
        input: (o) => shapeJson(shape, o, "input"),
        output: (o) => shapeJson(shape, o, "output"),
      },
    },
  };
}

function shapeJson(
  shape: Record<string, StandardLike>,
  options: unknown,
  io: "input" | "output",
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    properties[key] = schema["~standard"].jsonSchema?.[io](options) ?? {};
    const probe = schema["~standard"].validate(undefined);
    // Sync validators tell us whether the field is optional; async ones are treated as required.
    if (probe instanceof Promise || probe.issues) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/**
 * Wraps `inner` (a Standard Schema, a raw shape or undefined) so reserved
 * arguments are accepted, removed before validation, and remembered in
 * `reservedValues` for the validated value.
 */
export function withReservedArgs(
  inner: unknown,
  reserved: Record<string, Record<string, unknown>>,
): StandardLike {
  const base: StandardLike | undefined = isStandardSchema(inner)
    ? inner
    : isRawShape(inner)
      ? objectFromShape(inner)
      : undefined;
  const reservedKeys = Object.keys(reserved);

  const addReserved = (schema: Record<string, unknown>): Record<string, unknown> => {
    const properties = { ...((schema.properties as Record<string, unknown>) ?? {}) };
    for (const [key, json] of Object.entries(reserved)) properties[key] = json;
    return { ...schema, type: "object", properties };
  };

  return {
    "~standard": {
      version: 1,
      vendor: "gantry",
      async validate(input) {
        const extracted: Record<string, unknown> = {};
        let rest: unknown = input;
        if (input && typeof input === "object" && !Array.isArray(input)) {
          const copy: Record<string, unknown> = { ...(input as Record<string, unknown>) };
          for (const key of reservedKeys) {
            if (key in copy) {
              const value = copy[key];
              delete copy[key];
              if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
                return { issues: [{ message: `${key} must be a non-empty string`, path: [key] }] };
              }
              extracted[key] = value;
            }
          }
          rest = copy;
        }
        if (!base) {
          const value = {};
          reservedValues.set(value, extracted);
          return { value };
        }
        const res = await base["~standard"].validate(rest);
        if (res.issues) return res;
        const value = res.value;
        if (value && typeof value === "object") reservedValues.set(value, extracted);
        return { value };
      },
      jsonSchema: {
        input: (o) => addReserved(base?.["~standard"].jsonSchema?.input(o) ?? { type: "object" }),
        output: (o) => base?.["~standard"].jsonSchema?.output(o) ?? { type: "object" },
      },
    },
  };
}
