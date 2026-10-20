/**
 * How many runs a property gets: `ci` by default, or `FC_RUNS` when it is set (`FC_RUNS=2000 pnpm test` before a
 * release, or to chase a rare case).
 */
export const runs = (ci: number): number => {
  const asked = Number(process.env.FC_RUNS);
  return Number.isInteger(asked) && asked > 0 ? asked : ci;
};
