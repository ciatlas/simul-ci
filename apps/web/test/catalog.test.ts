/**
 * The bundled action catalog as scripts/build-catalog.mjs writes it (synthesis § 4.8): its schema, which the palette,
 * the With rows and Pin to SHA read without checking, and the rules the builder keeps: one entry per action, a ref and
 * the full commit it pointed at, descriptions cut to one line of at most 140 characters, and none quoted from an
 * action whose licence is not permissive.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import catalog from '../src/catalog/catalog.json';
import { type CatalogAction, catalogAction, catalogInputs, splitUses } from '../src/edit/catalog';

const LINE = z
  .string()
  .max(140)
  .refine((s) => !/[\r\n]/.test(s), 'one line');

const Input = z.strictObject({
  id: z.string().min(1),
  required: z.boolean(),
  default: LINE.optional(),
  deprecated: z.literal(true).optional(),
  description: LINE.min(1).optional(),
});

const Action = z.strictObject({
  uses: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+(?:\/[^\s@]+)?$/),
  ref: z.string().regex(/^[^\s@]+$/),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  name: LINE.min(1),
  description: LINE.min(1).optional(),
  inputs: z.array(Input),
  outputs: z.array(z.string().min(1)),
  license: z.string().min(1).nullable(),
});

/** The licences the builder quotes descriptions under (scripts/build-catalog.mjs). */
const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense',
  'Zlib',
]);

const actions = catalog as unknown as CatalogAction[];

describe('the bundled catalog', () => {
  it('is a list of actions in the shape the palette and Properties read', () => {
    expect(z.array(Action).min(1).parse(catalog)).toHaveLength(actions.length);
  });

  it('has one entry per action and one row per input', () => {
    const names = actions.map((a) => a.uses.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const a of actions) expect(new Set(a.inputs.map((i) => i.id)).size, a.uses).toBe(a.inputs.length);
  });

  it('quotes no description of an action whose licence is not permissive', () => {
    const closed = actions.filter((a) => a.license === null || !PERMISSIVE.has(a.license));
    for (const a of closed) {
      expect(a.description, a.uses).toBeUndefined();
      expect(
        a.inputs.filter((i) => i.description !== undefined),
        a.uses,
      ).toEqual([]);
    }
  });

  it('finds an action whatever the case of its name, and gives its inputs as With rows take them', () => {
    const checkout = catalogAction(actions, 'Actions/Checkout')!;
    expect(checkout.uses).toBe('actions/checkout');
    expect(catalogAction(actions, 'actions/checkout/sub')).toBeUndefined();
    const inputs = catalogInputs(checkout);
    expect(inputs.map((i) => i.name)).toEqual(checkout.inputs.map((i) => i.id));
    expect(inputs.find((i) => i.name === 'token')).toMatchObject({
      required: false,
      default: '${{ github.token }}',
    });
  });

  it('splits a uses: into its action and ref, and leaves local actions and images whole', () => {
    expect(splitUses('actions/checkout@v4')).toEqual({ name: 'actions/checkout', ref: 'v4' });
    expect(splitUses('github/codeql-action/init@v3')).toEqual({
      name: 'github/codeql-action/init',
      ref: 'v3',
    });
    expect(splitUses('./.github/actions/setup')).toEqual({ name: './.github/actions/setup' });
    expect(splitUses('docker://alpine@sha256:abc')).toEqual({ name: 'docker://alpine@sha256:abc' });
    expect(splitUses('actions/checkout')).toEqual({ name: 'actions/checkout' });
  });
});
