import { arkiv, createArkivReader, createArkivWriter, type ArkivWriter } from '@paperseal/arkiv';
import { createExamRegistry, resolveExamName } from '@paperseal/chain';
import { chain } from '@paperseal/protocol';
import { createSwarmClient } from '@paperseal/swarm';
import type { Address } from 'viem';

import { parseCommand, usage, UsageError, type BackupTarget, type IndexTarget, type MirrorTarget } from './args';
import { backupFailed, BackupRefused, batchCheckLine, checkBatch, planLines, prepareBackup, resultLines, uploadBackup } from './backup';
import { relayEnv, type RelayEnv } from './config';
import { dryCheck } from './dry-check';
import { indexLoop, indexPass, indexReportLines, indexTally, newIndexState, rpcLabel, type IndexDeps, type IndexReport } from './indexer';
import { keystoreAddress, loadSigner } from './keystore';
import { explorerLinks, mirrorPass, tally, type PassReport } from './mirror';
import { errorText, print, printError, registerSecret } from './output';
import { ageText, indexStatus, indexStatusLines, statusRows, type StatusRow } from './status';
import { apiLine, buyStamp, swarmSnapshot, swarmStatusLines } from './swarm-node';
import { abortableSleep, watch, type Beat } from './watch';

const links = explorerLinks(arkiv.network.explorer);

function accessKeyLine(env: RelayEnv): string {
  return env.accessKey.value
    ? `access key from ${env.accessKey.source ?? 'unknown'}`
    : 'no access key: the public RPC, which is rate limited';
}

/** The TEE part of a pass's summary. A stage is shown only for a TEE that serves this exam. */
export function teeSummary(tee: PassReport['tee']): string {
  if (tee.servesExam === true) return tee.stage ? `  (TEE stage ${tee.stage})` : '';
  if (tee.servesExam === false) return '  (TEE serves another exam)';
  return tee.stage ? '  (TEE shows no exam)' : '';
}

export function summaryLine(report: PassReport): string {
  const counts = tally(report);
  return `[${report.at.toISOString()}] written ${String(counts.written)}, skipped ${String(counts.skipped)}, held ${String(counts.held)}, refused ${String(counts.refused)}, failed ${String(counts.failed)}${teeSummary(report.tee)}`;
}

/** Prints one pass: every outcome, with its entity, transaction and explorer link, then notes. */
export function printReport(report: PassReport): void {
  print(summaryLine(report));
  for (const o of report.outcomes) {
    print(`  ${o.kind.padEnd(5)} ${o.source.padEnd(7)} ${o.result.padEnd(7)} ${o.detail}`);
    if (o.entityKey) print(`        entity ${o.entityKey}  ${links.entity(o.entityKey)}`);
    if (o.txHash) print(`        tx     ${o.txHash}  ${links.tx(o.txHash)}`);
  }
  for (const note of report.notes) print(`  note  ${note}`);
}

function header(env: RelayEnv, target: MirrorTarget, writer: Address): void {
  print(`Arkiv     ${arkiv.network.name} (chain ${String(arkiv.network.chainId)}), ${accessKeyLine(env)}`);
  print(`writer    ${writer}  ${links.address(writer)}`);
  print(`exam      ${target.examId}`);
  print(`registry  ${target.registry} (chain ${String(chain.chainId)})`);
  print(`sources   ${[target.storageUrl && `storage ${target.storageUrl}`, target.teeUrl && `TEE ${target.teeUrl}`].filter(Boolean).join(', ')}`);
}

export function printBeat(beat: Beat): void {
  print(`[${beat.at.toISOString()}] heartbeat written: entriesHash ${beat.entriesHash ?? 'none'}, TEE stage ${beat.stage ?? 'none'}`);
  print(`        entity ${beat.entityKey}  ${links.entity(beat.entityKey)}`);
  print(`        tx     ${beat.txHash}  ${links.tx(beat.txHash)}`);
}

/** Heartbeats can number in the hundreds, so `status` shows only the newest few. */
const heartbeatsShown = 10;

function printRow(row: StatusRow): void {
  const when = row.writtenAt ? new Date(row.writtenAt * 1000).toISOString() : 'unknown time';
  print(`  ${row.kind.padEnd(9)} block ${String(row.createdAtBlock)}  ~${when} (${ageText(row.ageSeconds)})  registry ${row.registry}`);
  print(`            ${row.detail}`);
  print(`            entity ${row.entityKey}  ${links.entity(row.entityKey)}`);
}

export function printIndexReport(report: IndexReport): void {
  for (const line of indexReportLines(report, links)) print(line);
}

const rpcSourceText = { '--rpc': 'from --rpc', RELAY_SEPOLIA_RPC: 'from RELAY_SEPOLIA_RPC', default: 'the public default (pass --rpc or set RELAY_SEPOLIA_RPC to change it)' } as const;

function indexHeader(env: RelayEnv, target: IndexTarget, writer: Address): void {
  print(`Arkiv     ${arkiv.network.name} (chain ${String(arkiv.network.chainId)}), ${accessKeyLine(env)}`);
  print(`writer    ${writer}  ${links.address(writer)}`);
  print(`registry  ${target.registry} (chain ${String(chain.chainId)})`);
  print(`Sepolia   ${rpcLabel(target.rpcUrl).shown}, ${rpcSourceText[target.rpcSource]}`);
  print(`blocks    ${target.fromBlock.toString()} to ${target.toBlock?.toString() ?? 'latest'}, ${String(arkiv.logChunkBlocks)} per log query`);
  print(`names     ${target.names.length > 0 ? target.names.join(', ') : 'none (pass --names to index exam names)'}`);
}

async function runIndex(env: RelayEnv, target: IndexTarget): Promise<void> {
  for (const secret of rpcLabel(target.rpcUrl).secrets) registerSecret(secret);
  const writer = await signedWriter(env);
  indexHeader(env, target, writer.address);
  const deps: IndexDeps = {
    registry: createExamRegistry({ address: target.registry, rpcUrl: target.rpcUrl }),
    writer,
    resolveName: (name) => resolveExamName(name, { rpcUrl: target.rpcUrl }),
    chainId: chain.chainId,
    chunk: arkiv.logChunkBlocks,
  };

  if (target.everySeconds === undefined) {
    const report = await indexPass(target, deps, newIndexState(target.fromBlock));
    printIndexReport(report);
    const t = indexTally(report);
    if (t.failed > 0 || t.held > 0 || t.listsRefused > 0 || t.listsFailed > 0) process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    print('stopping after this pass (Ctrl+C again to quit now)');
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  print(`indexing every ${String(target.everySeconds)}s from the last block scanned, until Ctrl+C`);
  try {
    const state = await indexLoop(target, {
      ...deps,
      sleep: abortableSleep,
      signal: controller.signal,
      onReport: printIndexReport,
      onError: (message) => printError(`  error ${message}`),
    });
    print(`stopped; the next scan would start at block ${state.nextBlock.toString()}`);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function runBackup(env: RelayEnv, target: BackupTarget): Promise<void> {
  for (const secret of rpcLabel(target.rpcUrl).secrets) registerSecret(secret);
  const swarm = createSwarmClient({ apiUrl: target.swarm.url });
  print(`exam      ${target.examId}`);
  print(`registry  ${target.registry} (chain ${String(chain.chainId)})`);
  print(`storage   ${target.storageUrl}`);
  print(`Sepolia   ${rpcLabel(target.rpcUrl).shown}, ${rpcSourceText[target.rpcSource]}`);
  print(apiLine(target.swarm));
  print(`network   ${arkiv.swarm.network} (swarm.network in spec/arkiv.json)`);

  const refused = (error: unknown) => {
    if (!(error instanceof BackupRefused)) throw error;
    printError(`REFUSED   ${errorText(error)}`);
    printError('          nothing was uploaded and nothing was written');
    process.exitCode = 1;
  };
  let plan;
  try {
    plan = await prepareBackup(target, {
      fetch: globalThis.fetch,
      registry: createExamRegistry({ address: target.registry, rpcUrl: target.rpcUrl }),
    });
  } catch (error) {
    refused(error);
    return;
  }
  for (const line of planLines(plan)) print(line);
  try {
    print(batchCheckLine(await checkBatch(swarm, target.batchId)));
  } catch (error) {
    refused(error);
    return;
  }
  if (target.dryRun) {
    print('dry run: every check passed; nothing was uploaded and nothing was written');
    return;
  }

  // The key is loaded before the upload, so a keystore problem stops the run with nothing sent.
  const writer = await signedWriter(env);
  print(`Arkiv     ${arkiv.network.name} (chain ${String(arkiv.network.chainId)}), ${accessKeyLine(env)}`);
  print(`writer    ${writer.address}  ${links.address(writer.address)}`);
  print(`uploading ${String(plan.files.length)} files, waiting for Bee to push every chunk (Swarm-Deferred-Upload: false)…`);
  const result = await uploadBackup(target, plan, { swarm, writer });
  for (const line of resultLines(result, target.swarm.url, links)) print(line);
  if (backupFailed(result)) process.exitCode = 1;
}

async function signedWriter(env: RelayEnv): Promise<ArkivWriter> {
  const account = await loadSigner(env.keystore);
  return createArkivWriter({ account, accessKey: env.accessKey.value });
}

/** Every error is printed through output.ts, so the access key can't leak in an RPC URL. */
export async function main(argv: string[]): Promise<void> {
  try {
    await run(argv);
  } catch (error) {
    printError(`\nERROR ${errorText(error)}`);
    process.exitCode = 1;
  }
}

async function run(argv: string[]): Promise<void> {
  let command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    printError(`${error.message}\n\n${usage}`);
    process.exitCode = 2;
    return;
  }

  if (command.command === 'help') {
    print(usage);
    return;
  }
  if (command.command === 'dry-check') {
    await dryCheck();
    return;
  }
  if (command.command === 'swarm-status') {
    for (const line of swarmStatusLines(await swarmSnapshot(command.swarm, createSwarmClient({ apiUrl: command.swarm.url })))) print(line);
    return;
  }
  if (command.command === 'buy-stamp') {
    const outcome = await buyStamp({ api: command.swarm, depth: command.depth, days: command.days, label: command.label, yes: command.yes }, createSwarmClient({ apiUrl: command.swarm.url }));
    for (const line of outcome.lines) print(line);
    process.exitCode = outcome.exitCode;
    return;
  }

  const env = relayEnv();
  registerSecret(env.accessKey.value);

  if (command.command === 'status-index') {
    const writer = command.writer ?? (await keystoreAddress(env.keystore));
    const reader = createArkivReader({ accessKey: env.accessKey.value });
    print(`Arkiv     ${arkiv.network.name}, ${accessKeyLine(env)}`);
    print(`writer    ${writer}${command.writer ? '' : ` (keystore ${env.keystore.account})`}  ${links.address(writer)}`);
    print(`registry  ${command.registry}`);
    for (const line of indexStatusLines(await indexStatus(reader, command.registry, writer), links.entity)) print(line);
    return;
  }

  if (command.command === 'index') {
    await runIndex(env, command.target);
    return;
  }

  if (command.command === 'backup') {
    await runBackup(env, command.target);
    return;
  }

  if (command.command === 'status') {
    const writer = command.writer ?? (await keystoreAddress(env.keystore));
    const reader = createArkivReader({ accessKey: env.accessKey.value });
    print(`Arkiv     ${arkiv.network.name}, ${accessKeyLine(env)}`);
    print(`writer    ${writer}${command.writer ? '' : ` (keystore ${env.keystore.account})`}  ${links.address(writer)}`);
    print(`exam      ${command.examId}`);
    print(`registry  ${command.registry ?? 'any (pass --registry to narrow)'}`);
    const { rows, heartbeats, latest } = await statusRows(reader, command.examId, writer, command.registry);
    print(`${String(rows.length)} row${rows.length === 1 ? '' : 's'} from this writer${latest ? ` (latest Arkiv block ${String(latest.number)})` : ''}, newest first`);
    for (const row of rows) printRow(row);
    const shown = heartbeats.slice(0, heartbeatsShown);
    print(
      `${String(heartbeats.length)} heartbeat${heartbeats.length === 1 ? '' : 's'} from this writer, newest first${heartbeats.length > shown.length ? ` (the newest ${String(shown.length)} shown)` : ''}`,
    );
    for (const row of shown) printRow(row);
    return;
  }

  const writer = await signedWriter(env);
  header(env, command.target, writer.address);
  const deps = { fetch: globalThis.fetch, writer, chainId: chain.chainId };

  if (command.command === 'mirror') {
    const report = await mirrorPass(command.target, deps);
    printReport(report);
    const counts = tally(report);
    if (counts.failed > 0 || counts.refused > 0) process.exitCode = 1;
    return;
  }

  // watch
  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    print('stopping after this pass (Ctrl+C again to quit now)');
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  print(`watching every ${String(command.everySeconds)}s until the TEE says released or failed, or Ctrl+C`);
  print(command.heartbeat ? `heartbeat every ${String(arkiv.heartbeatSeconds)}s while watching` : 'no heartbeat (--no-heartbeat)');
  try {
    const end = await watch(command.target, command.everySeconds, {
      ...deps,
      sleep: abortableSleep,
      signal: controller.signal,
      onReport: printReport,
      onError: (message) => printError(`  error ${message}`),
      heartbeat: command.heartbeat ? { seconds: arkiv.heartbeatSeconds, write: writer.heartbeat, onWritten: printBeat } : undefined,
    });
    print(end === 'stopped' ? 'stopped' : `the TEE says ${end}; the mirror is done`);
  } catch (error) {
    printError(`watch stopped: ${errorText(error)}`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
