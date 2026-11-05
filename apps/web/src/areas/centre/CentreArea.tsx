import { roundAtSeconds } from '@paperseal/protocol';
import { Connected, EmptyState, Mono, Row, Rows, Screen } from '@paperseal/ui';

import { ReleaseRoute } from '../../release/ReleaseRoute';
import { Area, type AreaScreen } from '../../shared/Area';
import { Register } from '../../shared/Register';
import { fromExam, notConnectedToChain } from '../../shared/registry';
import { fromTee, notConnectedToTee } from '../../shared/tee';
import { TeeStatus } from '../../shared/TeeStatus';

const loadBuild = fromExam((registry, id) => registry.getBuild(id));
const loadExam = fromExam(async (registry, id) => ({
  exam: await registry.getExam(id),
  roundAtLoad: roundAtSeconds(Math.floor(Date.now() / 1000)),
}));
const loadLog = fromTee((tee) => tee.releaseLog());

function Download() {
  return (
    <Screen title="Download" lede="Fetch the encrypted paper ahead of the exam.">
      <Connected title="Committed paper" notConnected={notConnectedToChain} load={loadBuild}>
        {(build) =>
          build ? (
            <Rows>
              <Row label="Paper hash">
                <Mono>{build.paperHash}</Mono>
              </Row>
              <Row label="Manifest hash">
                <Mono>{build.storageManifestHash}</Mono>
              </Row>
            </Rows>
          ) : (
            'No paper has been committed yet.'
          )
        }
      </Connected>
      <EmptyState title="Nothing downloaded">
        Download is not built. The storage manifest format is not in spec/ yet.
      </EmptyState>
    </Screen>
  );
}

function Countdown() {
  return (
    <Screen title="Countdown" lede="Unlock follows the drand round, the only clock.">
      <Connected title="Unlock round" notConnected={notConnectedToChain} load={loadExam}>
        {({ exam, roundAtLoad }) =>
          exam ? (
            <Rows>
              <Row label="Unlock round">{exam.settings.unlockRound.toString()}</Row>
              <Row label="Round at load">{roundAtLoad}</Row>
            </Rows>
          ) : (
            'This exam has not been published.'
          )
        }
      </Connected>
    </Screen>
  );
}

function Unlock() {
  return (
    <Screen title="Unlock" lede="Touch your security key to open the paper once K_priv arrives.">
      <TeeStatus />
      <EmptyState title="Paper locked">
        Unlock needs the downloaded paper, the time seal and your encrypted copy of the key.
      </EmptyState>
    </Screen>
  );
}

function UnlockLog() {
  return (
    <Screen title="Unlock log" lede="The TEE's signed release log.">
      <Connected title="Release log" notConnected={notConnectedToTee} load={loadLog}>
        {({ entries }) =>
          entries.length === 0 ? (
            'No releases yet.'
          ) : (
            <Rows>
              {entries.map((entry) => (
                <Row key={entry.holderId} label={entry.holderId}>
                  round {entry.round}
                </Row>
              ))}
            </Rows>
          )
        }
      </Connected>
    </Screen>
  );
}

export const screens: AreaScreen[] = [
  { path: '', label: 'Download', element: <Download /> },
  { path: 'countdown', label: 'Countdown', element: <Countdown /> },
  { path: 'register', label: 'Register', element: <Register /> },
  { path: 'release', label: 'Release', element: <ReleaseRoute /> },
  { path: 'unlock', label: 'Unlock', element: <Unlock /> },
  { path: 'log', label: 'Log', element: <UnlockLog /> },
];

export default function CentreArea() {
  return <Area name="Centre" base="/centre" screens={screens} />;
}
