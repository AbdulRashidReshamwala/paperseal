import { useMemo } from 'react';

import { Area, type AreaScreen } from '../../shared/Area';
import { Receipt, SignIn, Upload } from './screens';
import { defaultEnv, SessionProvider, type SetterEnv } from './session';

export const screens: AreaScreen[] = [
  { path: '', label: 'Sign in', element: <SignIn /> },
  { path: 'upload', label: 'Upload', element: <Upload /> },
  { path: 'receipt', label: 'Receipt', element: <Receipt /> },
];

/** The session holds the confirmed TEE across the three screens. Tests pass `env` with stubs. */
export default function SetterArea(props: { env?: SetterEnv }) {
  const env = useMemo(() => props.env ?? defaultEnv(), [props.env]);
  return (
    <SessionProvider env={env}>
      <Area name="Setter" base="/setter" screens={screens} />
    </SessionProvider>
  );
}
