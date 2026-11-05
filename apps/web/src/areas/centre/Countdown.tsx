import type { ExamRegistry } from '@paperseal/chain';
import { drand, roundAtSeconds, roundTimeSeconds, roles, type Hex } from '@paperseal/protocol';
import { Badge, Connected, Row, Rows, Screen } from '@paperseal/ui';
import { useEffect, useMemo, useState } from 'react';

import { useCurrentExamId, useExamLoader } from '../../shared/currentExam';
import { useHolderCredential } from '../../shared/holder';
import { notConnectedToChain, registry } from '../../shared/registry';
import { roleOnList } from './readers';

const readExam = (client: ExamRegistry, id: Hex) => client.getExam(id);

/** Whole seconds remaining until a drand round is produced, from its time in the quicknet schedule. */
export function secondsUntilRound(round: number, nowSeconds: number): number {
  return Math.max(0, roundTimeSeconds(round) - nowSeconds);
}

export function formatRemaining(totalSeconds: number): string {
  const [h, m, s] = [Math.floor(totalSeconds / 3600), Math.floor((totalSeconds % 3600) / 60), totalSeconds % 60];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(h)}:${pad(m)}:${pad(s)}`;
}

function useNowSeconds(now: () => number): number {
  const [seconds, setSeconds] = useState(() => Math.floor(now() / 1000));
  useEffect(() => {
    const id = setInterval(() => {
      setSeconds(Math.floor(now() / 1000));
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [now]);
  return seconds;
}

/** The countdown to T−Δ, in drand rounds: the time seal opens when round `unlockRound` is produced. */
export function UnlockClock(props: { unlockRound: number; now?: () => number }) {
  const now = useMemo(() => props.now ?? (() => Date.now()), [props.now]);
  const seconds = useNowSeconds(now);
  const current = roundAtSeconds(seconds);
  const remaining = secondsUntilRound(props.unlockRound, seconds);
  return (
    <Rows>
      <Row label="Unlock round">{props.unlockRound}</Row>
      <Row label="Current drand round">{current}</Row>
      <Row label="Rounds to go">{Math.max(0, props.unlockRound - current)}</Row>
      <Row label="Time to T−Δ">
        {remaining === 0 ? <Badge tone="ok">The time seal is open</Badge> : formatRemaining(remaining)}
      </Row>
      <Row label="Round length">{drand.periodSeconds} seconds</Row>
    </Rows>
  );
}

/** Says whether this browser's key is a key holder, who must also release a share at unlock. */
function ShareDuty() {
  const exam = useCurrentExamId();
  const identity = useHolderCredential('centre');
  const load = useMemo(() => {
    const reader = registry;
    return reader && exam && identity ? () => roleOnList(reader, exam, identity.passkeyPublicKey) : null;
  }, [exam, identity]);
  return (
    <Connected title="Your role" notConnected="Register your security key in this browser, and set the chain and exam, to see your role." load={load}>
      {(role) =>
        role === roles.centreKeyHolder ? (
          <>Your centre holds a share. Release it on the Release screen once the time seal opens.</>
        ) : role === roles.centre ? (
          <>Your centre receives K_priv at unlock and holds no share.</>
        ) : (
          <>Your key is not a centre on the approved list.</>
        )
      }
    </Connected>
  );
}

export function Countdown() {
  const loadExam = useExamLoader(readExam);
  return (
    <Screen title="Countdown" lede="Unlock follows the drand round, the only clock.">
      <Connected title="Unlock round" notConnected={notConnectedToChain} load={loadExam}>
        {(exam) =>
          exam ? (
            <UnlockClock unlockRound={Number(exam.settings.unlockRound)} />
          ) : (
            'This exam has not been published.'
          )
        }
      </Connected>
      <ShareDuty />
    </Screen>
  );
}
