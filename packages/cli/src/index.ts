#!/usr/bin/env node
import { VERSION } from '@simulci/engine';
import { defineCommand, runMain } from 'citty';
import { planCommand } from './plan';

const main = defineCommand({
  meta: {
    name: 'simulci',
    version: VERSION,
    description: 'Static simulator and test framework for GitHub Actions',
  },
  subCommands: { plan: planCommand },
});

runMain(main);
