import { afterAll, beforeAll } from 'vitest';

import { boardTests } from './board';
import { holderTests } from './holders';
import { verifierTests } from './verifier';
import { startLab, type Lab } from './lab';
import { writeReport } from './kit';

let lab: Lab;
beforeAll(async () => {
  lab = await startLab();
});
afterAll(async () => {
  writeReport('local');
  await lab?.stop();
});

boardTests(() => lab);
holderTests(() => lab);
verifierTests(() => lab);
