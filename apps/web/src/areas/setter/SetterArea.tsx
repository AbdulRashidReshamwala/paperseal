import { padding } from '@paperseal/protocol';
import { EmptyState, Row, Rows, Screen } from '@paperseal/ui';

import { Area, type AreaScreen } from '../../shared/Area';
import { TeeStatus } from '../../shared/TeeStatus';

function SignIn() {
  return (
    <Screen title="Sign in" lede="Setters sign in with a passkey on a security key.">
      <TeeStatus />
      <EmptyState title="Sign-in unavailable">
        The TEE API has no setter sign-in route yet, so sign-in is not built.
      </EmptyState>
    </Screen>
  );
}

function Upload() {
  return (
    <Screen
      title="Upload questions"
      lede="Questions are padded to a fixed size and encrypted to the TEE's attested key."
    >
      <EmptyState title="Upload locked">
        Questions are only encrypted once the TEE's attestation passes, and that check is not complete
        yet. Each question is padded to {padding.questionBytes} bytes.
      </EmptyState>
    </Screen>
  );
}

function Receipt() {
  return (
    <Screen title="Receipt" lede="Your sealed receipts for this session.">
      <Rows>
        <Row label="Sealed questions">0</Row>
      </Rows>
      <EmptyState title="No receipts yet">Upload a question to get a sealed receipt.</EmptyState>
    </Screen>
  );
}

export const screens: AreaScreen[] = [
  { path: '', label: 'Sign in', element: <SignIn /> },
  { path: 'upload', label: 'Upload', element: <Upload /> },
  { path: 'receipt', label: 'Receipt', element: <Receipt /> },
];

export default function SetterArea() {
  return <Area name="Setter" base="/setter" screens={screens} />;
}
