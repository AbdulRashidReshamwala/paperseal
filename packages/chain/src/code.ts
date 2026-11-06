import { registryCode, type Hex } from '@paperseal/protocol';
import { getAddress, isHex, sha256, type Address } from 'viem';

/*
 * The code pin, from "Registry Code" in spec/api.md: what shows an address really is ExamRegistry.
 * The hash, length and offsets are in spec/registry.json, which `make abi` writes, so the name check,
 * the verifier and the TEE all check the same thing.
 */

/** `match`: the address runs ExamRegistry, for `board`. `none`: no code there. `different`: some other contract. */
export type RegistryCodeCheck = { state: 'match'; board: Address } | { state: 'none' } | { state: 'different' };

/** Code digits, with no `0x`, without the trailing metadata: the last two bytes, big-endian, plus that many before them. Null if that doesn't fit. */
function withoutMetadata(code: string): string | null {
  const digits = code.length - 2;
  if (digits % 2 !== 0 || digits < 4) return null;
  const metadata = parseInt(code.slice(-4), 16) + 2;
  if (metadata > digits / 2) return null;
  return code.slice(2, code.length - metadata * 2);
}

const ZERO_WORD = '0'.repeat(64);
const ADDRESS_PAD = '0'.repeat(24);

/**
 * The `board` written into `code`, or null unless `code` is ExamRegistry's. The metadata solc appends is
 * left out, because a comment edit changes it. Every `board` word must hold one non-zero address, and
 * with those words zeroed the rest must hash to the pin.
 */
export function examRegistryBoard(code: Hex): Address | null {
  if (!isHex(code, { strict: true })) return null;
  const executable = withoutMetadata(code.toLowerCase());
  if (executable?.length !== registryCode.executableBytes * 2) return null;
  let masked = executable;
  const words = new Set<string>();
  for (const offset of registryCode.boardOffsets) {
    const at = offset * 2;
    words.add(executable.slice(at, at + 64));
    masked = masked.slice(0, at) + ZERO_WORD + masked.slice(at + 64);
  }
  const [word] = words;
  if (words.size !== 1 || word === undefined || word === ZERO_WORD || !word.startsWith(ADDRESS_PAD)) return null;
  if (sha256(`0x${masked}`) !== registryCode.runtimeCodeHash) return null;
  return getAddress(`0x${word.slice(ADDRESS_PAD.length)}`);
}

/** Whether `code` is ExamRegistry's deployed code with `board` as its `board` immutable. */
export function isExamRegistryCode(code: Hex, board: Address): boolean {
  return examRegistryBoard(code)?.toLowerCase() === board.toLowerCase();
}

/** What the code at an address, as `eth_getCode` gave it, says about that address. */
export function checkRegistryCode(code: Hex | undefined): RegistryCodeCheck {
  if (code === undefined || code === '0x') return { state: 'none' };
  const board = examRegistryBoard(code);
  return board ? { state: 'match', board } : { state: 'different' };
}
