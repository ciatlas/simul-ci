import monorepoCi from '../samples/monorepo/ci.yml?raw';
import monorepoPackage from '../samples/monorepo/package.yml?raw';
import starterCi from '../samples/starter/ci.yml?raw';
import starterRelease from '../samples/starter/release.yml?raw';
import starterSetup from '../samples/starter/setup-action.yml?raw';

/** Two small repositories bundled with the page, so the first plan needs no files of the author's. */
export interface Sample {
  name: string;
  title: string;
  blurb: string;
  files: Record<string, string>;
}

export const SAMPLES: Sample[] = [
  {
    name: 'starter',
    title: 'Starter',
    blurb: 'test matrix, a script output, a deploy gated on the event, a tag release and a composite action',
    files: {
      '.github/workflows/ci.yml': starterCi,
      '.github/workflows/release.yml': starterRelease,
      '.github/actions/setup/action.yml': starterSetup,
    },
  },
  {
    name: 'monorepo',
    title: 'Monorepo',
    blurb: 'paths-filter outputs deciding two reusable workflow calls and an always() gate',
    files: {
      '.github/workflows/ci.yml': monorepoCi,
      '.github/workflows/package.yml': monorepoPackage,
    },
  },
];

export const sampleByName = (name: string): Sample | undefined => SAMPLES.find((s) => s.name === name);
