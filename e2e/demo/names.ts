import { nameRecordCalls, writeNameRecords } from '../live/names';
import { plantedCards } from './cards';

/*
 * The directory for `pnpm demo:keys`.
 *
 *   node e2e/demo/cli.mjs names         prints each key holder's and centre's card. It sends nothing.
 *   node e2e/demo/cli.mjs names write   writes them with the board keystore, as `pnpm live` does.
 *
 * `write` replaces the records on those names, so it costs Sepolia gas and any key enrolled on them
 * stops matching. It needs doing once, because planted keys never change. `names` shows what it would send.
 */
export async function main(argv: string[]): Promise<void> {
  const [command] = argv;
  if (command !== undefined && command !== 'write') throw new Error('usage: cli.mjs names [write]');
  const cards = await plantedCards();
  if (command === 'write') {
    await writeNameRecords(cards, (line) => {
      console.log(line);
    });
    return;
  }
  console.log(JSON.stringify(cards, null, 2));
  console.log(`\nNothing was sent. \`node e2e/demo/cli.mjs names write\` would send ${String(nameRecordCalls(cards).length)} records.`);
}
