// Validate the plugin's tool schemas using the HOST'S OWN assertion function.
//
// The previous verification compiled the authoring DSL and checked the result
// against my own expectations — which is exactly how an invalid schema slipped
// through. This test calls the same predicate `ctx.tools.register` calls, so a
// passing run means the host will accept the registration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { findDshModules, DSH_SKIP_REASON } from './dsh-install.mjs';

const DSH = findDshModules();
const skip = DSH === undefined ? DSH_SKIP_REASON : false;

/** Import a module from the host install, or nothing when there is no install. */
const importHost = async (relative) => {
  if (DSH === undefined) return {};
  return import(pathToFileURL(`${DSH}/${relative}`).href);
};

const hostTools = await importHost('dsh-tools/lib/index.js');
// The plugin hands `ctx.tools.register` a JSON Schema it authored itself, not
// the `defineTool` authoring DSL, so the checks below use the JSON-Schema-side
// entry points: `assertSupportedJsonSchema` (what `register` calls on every
// schema) and `validateJsonSchemaValue` (what `defineTool` binds for arguments).
const { validateJsonSchemaValue } = await importHost('dsh-tools/lib/types/json-schema.js');

const { apply } = await import('../lib/index.js');

/** Load the plugin and capture what it registers. */
function capture() {
  const registered = [];
  const ctx = {
    tools: { register: (d) => (registered.push(d), () => {}) },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    logger: { warn() {} },
  };
  apply(ctx, {});
  return registered;
}

// Find the host's schema assertion. `register` calls it internally; it may be
// exported, and if not we reach it through the module namespace.
const assertionCandidates = Object.entries(hostTools).filter(
  ([k, v]) => typeof v === 'function' && /schema/i.test(k),
);

test('every tool schema passes the HOST assertSupportedJsonSchema', { skip }, () => {
  const { assertSupportedJsonSchema } = hostTools;
  assert.equal(typeof assertSupportedJsonSchema, 'function', 'host must export the assertion');

  const registered = capture();
  assert.equal(registered.length, 2);

  for (const tool of registered) {
    // Throws JsonSchemaError with the exact violations the host would report.
    assert.doesNotThrow(
      () => assertSupportedJsonSchema(tool.output.schema),
      `${tool.name} output schema must be accepted by the host`,
    );
    // `register` only asserts the output half, but the parameters half must not
    // violate the same subset rules or the model endpoint rejects it.
    assert.doesNotThrow(
      () => assertSupportedJsonSchema(tool.parameters),
      `${tool.name} parameter schema must be accepted by the host`,
    );
  }
});

test('the host assertion rejects the exact mistake this plugin made', { skip }, () => {
  const { assertSupportedJsonSchema } = hostTools;
  // Regression guard: `required` on an array/string node is what broke
  // activation before. If the host ever starts accepting it, this fails loudly.
  const bad = {
    type: 'object',
    properties: {
      list: { type: 'array', required: true, items: { type: 'string' } },
    },
  };
  assert.throws(
    () => assertSupportedJsonSchema(bad),
    /required is not supported on type "array"/,
    'host must reject required on an array node',
  );
});

test('every registered tool output schema passes the host subset rules', { skip }, async () => {
  const registered = capture();
  assert.equal(registered.length, 2);

  // Rebuild the host's rule table and walk each schema ourselves, mirroring
  // assertSupportedJsonSchema exactly (including the object-only `required`).
  const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
  const KEY_TYPES = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
  };

  function walk(node, path, violations) {
    if (Array.isArray(node.oneOf)) {
      if (node.oneOf.length < 2) violations.push(`${path}.oneOf must have at least two schemas`);
      node.oneOf.forEach((n, i) => walk(n, `${path}.oneOf[${i}]`, violations));
      return;
    }
    const type = node.type;
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')} (got ${JSON.stringify(type)})`);
      return;
    }
    for (const [key, types] of Object.entries(KEY_TYPES)) {
      if (Object.hasOwn(node, key) && !types.includes(type)) {
        violations.push(`${path}.${key} is not supported on type "${type}"`);
      }
    }
    if (type === 'object') {
      if (Object.hasOwn(node, 'required') && !Array.isArray(node.required)) {
        violations.push(`${path}.required must be an array of property names`);
      }
      if (Object.hasOwn(node, 'properties')) {
        for (const [name, child] of Object.entries(node.properties)) {
          walk(child, `${path}.properties.${name}`, violations);
        }
      }
    }
    if (type === 'array' && Object.hasOwn(node, 'items')) {
      walk(node.items, `${path}.items`, violations);
    }
  }

  for (const tool of registered) {
    const violations = [];
    walk(tool.output.schema, `${tool.name}.output.schema`, violations);
    assert.deepEqual(violations, [], `${tool.name} output schema violations: ${violations.join('; ')}`);
  }
});

test('parameter schemas are object-rooted and validate through the host', { skip }, () => {
  const registered = capture();
  for (const tool of registered) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be object-rooted`);
    // `required` is present only when at least one property is required.
    if (Object.hasOwn(tool.parameters, 'required')) {
      assert.ok(
        Array.isArray(tool.parameters.required),
        `${tool.name} required must be an array when present`,
      );
    }
  }

  const validate = (schema, args) => validateJsonSchemaValue(schema, args, '');

  const trash = registered.find((t) => t.name === 'file_trash');
  assert.deepEqual(validate(trash.parameters, { paths: ['C:/tmp/a.txt'] }), []);
  assert.ok(validate(trash.parameters, {}).length > 0, 'missing paths must be a violation');
  assert.ok(validate(trash.parameters, { paths: [42] }).length > 0, 'non-string element must violate');

  // file_trash has a required property; trash_status has none.
  const status = registered.find((t) => t.name === 'trash_status');
  assert.deepEqual(validate(status.parameters, {}), [], 'trash_status must accept no arguments');
  assert.deepEqual(validate(status.parameters, { drive: 'D:' }), []);
});

test('no `required` key sits on a non-object node anywhere', { skip }, () => {
  const registered = capture();
  const offenders = [];

  function walk(node, path) {
    if (node === null || typeof node !== 'object') return;
    if (Object.hasOwn(node, 'required') && node.type !== 'object') {
      offenders.push(path);
    }
    if (node.properties) {
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`);
    }
    if (node.items) walk(node.items, `${path}.items`);
  }

  for (const tool of registered) walk(tool.output.schema, tool.name);
  assert.deepEqual(offenders, [], `required on non-object nodes: ${offenders.join(', ')}`);
});
