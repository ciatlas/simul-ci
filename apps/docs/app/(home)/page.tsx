import Link from 'next/link';
import { REPO_URL } from '../../lib/site';

const PARTS = [
  {
    title: 'simulci plan',
    href: '/docs/cli/plan',
    text: 'The plan for a scenario: every job and step as runs, skips or might run, with the reason that decided it.',
  },
  {
    title: 'simulci test',
    href: '/docs/cli/test',
    text: 'Route tests in your repository, checked in CI in milliseconds: what runs, what skips, and why.',
  },
  {
    title: 'The GitHub Action',
    href: '/docs/action',
    text: 'The route tests on every pull request, with annotations on the line that decided and a job summary.',
  },
];

export default function HomePage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-12 px-4 py-16">
      <section className="flex flex-col gap-5">
        <h1 className="text-4xl font-semibold tracking-tight [font-stretch:110%] sm:text-5xl">
          What your workflow does, before it runs.
        </h1>
        <p className="max-w-2xl text-lg text-fd-muted-foreground">
          simulci reads your GitHub Actions workflows and a scenario (an event, a branch, the changed files)
          and tells you which jobs and steps run, skip or might run, and why. Nothing executes: no runner, no
          Docker.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/docs"
            className="rounded-md bg-fd-primary px-4 py-2 font-medium text-fd-primary-foreground hover:opacity-90"
          >
            Get started
          </Link>
          <a href={REPO_URL} className="rounded-md border px-4 py-2 font-medium hover:bg-fd-accent">
            GitHub
          </a>
        </div>
      </section>
      <pre className="overflow-x-auto rounded-lg border bg-fd-card p-4 font-mono text-sm">
        <code>npx simulci plan --event pull_request --head feat/x</code>
      </pre>
      <ul className="grid gap-6 sm:grid-cols-3">
        {PARTS.map((part) => (
          <li key={part.href}>
            <Link href={part.href} className="group flex flex-col gap-1">
              <span className="font-mono text-sm font-medium group-hover:text-fd-primary">{part.title}</span>
              <span className="text-sm text-fd-muted-foreground">{part.text}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
