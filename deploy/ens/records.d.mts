export interface RecordCall {
  what: string;
  data: `0x${string}`;
}

export function partyCalls(name: string, card: { passkey: string; credentialId: string }): RecordCall[];
export function directoryCall(parent: string, names: readonly string[]): RecordCall;
