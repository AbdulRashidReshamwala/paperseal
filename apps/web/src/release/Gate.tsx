import { Stage } from '@paperseal/ui';
import type { ReactNode } from 'react';

import { Register, type RegisterRole } from '../shared/Register';
import type { GateStage, HolderProgress, ProgressActions } from './progress';

/** The exact words a technical person needs, folded away from people under pressure. */
export function TechnicalDetail(props: { children: ReactNode }) {
  return (
    <details className="holder-detail">
      <summary>Details for your exam board</summary>
      <p>{props.children}</p>
    </details>
  );
}

/** The shared screens before a holder's own flow, one for each `GateStage`. */
export function Gate(props: { stage: GateStage; role: RegisterRole; progress: HolderProgress; actions: ProgressActions }) {
  const { stage, progress, actions } = props;
  switch (stage) {
    case 'setup':
      return (
        <Stage
          title="This page is not connected to the exam"
          lede="Contact your exam board. They need to finish setting up this page."
          next="Nothing can happen here until it is connected."
        >
          <TechnicalDetail>Missing at build time: {progress.missing.join(', ')}.</TechnicalDetail>
        </Stage>
      );
    case 'register':
      return <Register role={props.role} onRegistered={actions.registered} />;
    case 'ended':
      return (
        <Stage
          title="This exam has ended"
          lede="Registration is closed, so there is nothing to do on this page."
          next="If you think you should have been able to register, contact your exam board."
        />
      );
    case 'loading':
      return <Stage title="Checking the exam" next="This takes a few seconds, then this page shows what to do." />;
    case 'unreachable':
      return (
        <Stage
          title="Can't connect right now"
          lede="Check this computer's internet connection. This page keeps trying by itself."
          next="If this stays for more than a few minutes, contact your exam board."
        >
          {progress.chain.error ? <TechnicalDetail>{progress.chain.error}</TechnicalDetail> : null}
        </Stage>
      );
    case 'no-exam':
      return (
        <Stage
          title="Nothing to do yet"
          lede="Your exam board has not set up this exam yet."
          next="This page moves on by itself, so you can leave it open or come back to this link later."
        />
      );
    case 'awaiting-list':
      return (
        <Stage
          title="You are registered. Nothing to do yet."
          lede="Your exam board is still finishing the list of people for this exam."
          next="This page moves on by itself once the list is ready. To use a different security key, ask your exam board for a new invitation link."
        />
      );
    case 'not-on-list':
      return (
        <Stage
          title="Your security key is not on the list for this exam"
          lede={`Contact your exam board and give them the name you registered under: ${progress.credential?.owner ?? 'unknown'}.`}
          next="Nothing can go ahead on this page until your exam board has sorted this out."
        />
      );
  }
}
