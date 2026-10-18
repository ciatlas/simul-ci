import { z } from 'zod';
import { AssumeEntrySchema } from '../mocks/schema';
import { parseUnitPath, UnitPathError } from '../paths';
import { ScenarioInputSchema } from '../scenario';

/**
 * A route-test file (`.github/simulci/tests/<name>.test.yml`): one workflow, scenario defaults in `given`, and
 * cases whose `when` is a scenario and whose `then` says what runs, what skips and why, what the units receive
 * and produce. Values are compared in GitHub's string form; every key is checked, so a typo is an error, never a
 * passing test.
 */

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

/** A value assertion: a scalar, one of a list, a regular expression, or "still unknown". */
export const ExpectValueSchema = z.union([
  Scalar,
  z.array(Scalar).min(1),
  z.strictObject({ match: z.string().min(1) }),
  z.strictObject({ unknown: z.literal(true) }),
]);
export type ExpectValue = z.infer<typeof ExpectValueSchema>;

export const ResultSchema = z.enum(['success', 'failure', 'cancelled', 'skipped']);
export const ExpectResultSchema = z.union([
  ResultSchema,
  z.array(ResultSchema).min(1),
  z.strictObject({ unknown: z.literal(true) }),
]);
export type ExpectResult = z.infer<typeof ExpectResultSchema>;

/** `yes`, `no`, `maybe`; `true` and `false` are accepted because YAML 1.1 editors read `no` as a boolean. */
export const ExpectTriSchema = z.union([z.enum(['yes', 'no', 'maybe']), z.boolean()]);
export type ExpectTri = z.infer<typeof ExpectTriSchema>;

/** The words a `because:` may name: a reason kind, `filter` for any filter, or a filter's name. */
export const BECAUSE = [
  'event',
  'types',
  'schedule',
  'default-branch',
  'skip-ci',
  'parent',
  'if',
  'matrix',
  'limit',
  'filter',
  'branches',
  'branches-ignore',
  'tags',
  'tags-ignore',
  'paths',
  'paths-ignore',
  'workflows',
] as const;
export const BecauseSchema = z.enum(BECAUSE);
export type Because = z.infer<typeof BecauseSchema>;

const UNIT_PATH_HINT =
  'a unit path such as deploy, test[os=windows-latest].unit, publish.#2, release/build or build.changes/detect';

function isUnitPath(text: string): boolean {
  try {
    parseUnitPath(text);
    return true;
  } catch (e) {
    if (e instanceof UnitPathError) return false;
    throw e;
  }
}

export const UnitPathSchema = z.string().min(1).refine(isUnitPath, { message: UNIT_PATH_HINT });

/** `- deploy` or `- deploy: if` (the unit and the reason that decided it). */
export const RunEntrySchema = z.union([
  UnitPathSchema,
  z
    .record(UnitPathSchema, BecauseSchema)
    .refine((r) => Object.keys(r).length === 1, { message: 'one unit path per entry (`- deploy: if`)' }),
]);
export type RunEntry = z.infer<typeof RunEntrySchema>;

const scenarioKeys = Object.fromEntries(
  Object.keys(ScenarioInputSchema.shape).map((k) => [k, z.unknown().optional()]),
) as Record<keyof typeof ScenarioInputSchema.shape, z.ZodOptional<z.ZodUnknown>>;

/** The scenario of a case, keys checked here and values by `parseScenario` once merged with `given`. */
export const WhenSchema = z.strictObject({ ...scenarioKeys, assume: z.array(AssumeEntrySchema).optional() });
export type When = z.infer<typeof WhenSchema>;

export const GivenSchema = z.strictObject({
  ...scenarioKeys,
  assume: z.array(AssumeEntrySchema).optional(),
  allowMaybe: z.boolean().optional(),
  strictMocks: z.boolean().optional(),
});
export type Given = z.infer<typeof GivenSchema>;

const Values = z.record(z.string(), ExpectValueSchema);

export const UnitAssertionSchema = z
  .strictObject({
    runs: ExpectTriSchema.optional(),
    because: BecauseSchema.optional(),
    /** A step's result before `continue-on-error`. */
    outcome: ExpectResultSchema.optional(),
    /** A step's result after `continue-on-error`; a leg's result; every leg of a job (what its checks report). */
    conclusion: ExpectResultSchema.optional(),
    /** What `needs.<id>.result` reads for a job; a leg's result. */
    result: ExpectResultSchema.optional(),
    with: Values.optional(),
    inputs: Values.optional(),
    env: Values.optional(),
    outputs: Values.optional(),
    environment: ExpectValueSchema.optional(),
    /** A job's check names (exactly), or a leg's one name. */
    check: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .refine((u) => Object.keys(u).length > 0, { message: 'T102 a unit assertion asserts nothing' });
export type UnitAssertion = z.infer<typeof UnitAssertionSchema>;

export const ThenSchema = z
  .strictObject({
    triggered: z.boolean().optional(),
    /** The reason the workflow is not triggered; alone it implies `triggered: false`. */
    because: BecauseSchema.optional(),
    run: z.array(RunEntrySchema).optional(),
    skip: z.array(RunEntrySchema).optional(),
    maybe: z.array(RunEntrySchema).optional(),
    conclusion: z
      .union([
        z.enum(['success', 'failure', 'cancelled']),
        z.array(z.enum(['success', 'failure', 'cancelled'])).min(1),
        z.strictObject({ unknown: z.literal(true) }),
      ])
      .optional(),
    /** The workflow's check runs, exactly: their names, or their names with conclusions. */
    checks: z.union([z.array(z.string()), z.record(z.string(), ExpectResultSchema)]).optional(),
    /** The unknowns the plan keeps, exactly, in unit-path form. */
    unknowns: z.array(z.string()).optional(),
    units: z.record(UnitPathSchema, UnitAssertionSchema).optional(),
  })
  .refine((t) => Object.keys(t).length > 0, {
    message: 'T102 a case asserts nothing: add then or snapshot: true',
  })
  .refine((t) => !(t.because !== undefined && t.triggered === true), {
    message: 'because names what decided against the workflow; it cannot go with triggered: true',
    path: ['because'],
  });
export type Then = z.infer<typeof ThenSchema>;

export const CaseSchema = z
  .strictObject({
    name: z.string().min(1),
    when: WhenSchema,
    then: ThenSchema.optional(),
    allowMaybe: z.boolean().optional(),
    snapshot: z.union([z.boolean(), z.enum(['steps', 'legs'])]).optional(),
    skip: z.union([z.boolean(), z.string()]).optional(),
    only: z.boolean().optional(),
  })
  .refine((c) => c.then !== undefined || (c.snapshot !== undefined && c.snapshot !== false), {
    message: 'T102 a case asserts nothing: add then or snapshot: true',
  });
export type TestCase = z.infer<typeof CaseSchema>;

const WORKFLOW_NAME = /^(\.github\/workflows\/)?[^/\s]+\.ya?ml$/;

export const TestFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    /** `ci.yml` or `.github/workflows/ci.yml`. */
    workflow: z
      .string()
      .regex(WORKFLOW_NAME, 'the workflow file name, such as ci.yml or .github/workflows/ci.yml'),
    given: GivenSchema.optional(),
    cases: z.array(CaseSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const seen = new Map<string, number>();
    for (const [i, c] of file.cases.entries()) {
      const first = seen.get(c.name);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['cases', i, 'name'],
          message: `T103 duplicate case name '${c.name}' (first at cases[${first}])`,
        });
      } else seen.set(c.name, i);
    }
  });
export type TestFile = z.infer<typeof TestFileSchema>;

/** The full path of the file's workflow. */
export const workflowPathOf = (name: string): string =>
  name.startsWith('.github/workflows/') ? name : `.github/workflows/${name}`;

/** `yes`, `no` or `maybe` from what an author wrote. */
export const triOf = (v: ExpectTri): 'yes' | 'no' | 'maybe' => (v === true ? 'yes' : v === false ? 'no' : v);
