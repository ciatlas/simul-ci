import { config } from 'zod';

/**
 * Imported by the engine worker before the engine, whose schemas are built as its modules load. zod compiles object
 * parsers with `new Function` unless it is jitless, and the CSP (a `script-src` without 'unsafe-eval') refuses that,
 * so even zod's probe for it is a reported violation. Under the CSP zod parses without compiling anyway; jitless only
 * stops the probe.
 */
config({ jitless: true });
