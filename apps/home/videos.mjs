// The demo clips, in the order the page shows them. A clip whose file isn't in e2e/videos yet is left
// out of the page, along with any "Watch this step" link to it, so adding a video means recording it
// and running `pnpm --filter @paperseal/home ship`.
//
// `poster` is the second of the clip to use as its still.
export const videos = [
  {
    id: 'create-exam',
    title: 'The board creates an exam',
    line: 'Name, date, topics and limits, then key holders and centres picked by name.',
    poster: 3,
  },
  {
    id: 'setter-questions',
    title: 'A setter seals questions',
    line: 'Register a security key, write the questions, and send them straight into the sealed machine.',
    poster: 6.6,
  },
  {
    id: 'centre-register',
    title: 'A centre registers',
    line: 'The name is checked against the public directory, then the security key signs.',
    poster: 10.4,
  },
  {
    id: 'build-and-release',
    title: 'The machine builds, and key holders release',
    line: 'The paper is built and its record posted. At unlock, each key holder touches their key once.',
    poster: 3.3,
  },
  {
    id: 'centre-handout',
    title: 'The centre opens the paper',
    line: 'The key arrives, centre staff touch their security key, and the paper appears.',
    poster: 5,
  },
  {
    id: 'agent-check',
    title: 'Check with your own AI',
    line: 'Copy one prompt into any AI agent. It reads the originals and reports what passed.',
    poster: 3.3,
  },
];
