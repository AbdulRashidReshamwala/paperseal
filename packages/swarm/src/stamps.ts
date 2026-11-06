/**
 * Postage batch arithmetic, from https://docs.ethswarm.org/docs/concepts/incentives/postage-stamps
 * and the "Buy a Batch of Stamps" guide.
 *
 * A batch of depth `d` can stamp `2^d` chunks, and `amount` is the PLUR paid per chunk, so the
 * batch costs `2^d * amount` PLUR up front. The balance then drains by the oracle's current price
 * per chunk per block, so `amount` sets how long the data lives.
 */

/** Bee's smallest accepted batch depth. Its bucket depth is 16 and a batch must be deeper. */
export const minDepth = 17;

/** Every batch has `2^16` buckets. */
export const bucketDepth = 16;

/** 1 BZZ (xBZZ on mainnet, sBZZ on Sepolia) is `10^16` PLUR. */
export const plurPerBzz = 10n ** 16n;

/**
 * The docs' minimum batch validity in blocks: 24 hours of 5-second Gnosis blocks. Bee reports the
 * contract's own value as `minimumValidityBlocks` in `/chainstate`, which `minAmount` prefers.
 */
export const defaultMinimumValidityBlocks = 17_280;

export interface StampParams {
  /** PLUR per chunk. */
  amount: bigint;
  /** `log2` of the number of chunks the batch can stamp. */
  depth: number;
}

/** Throws unless `amount` is positive and `depth` is a whole number from `minDepth` to 255. */
export function checkStampParams({ amount, depth }: StampParams): void {
  if (amount <= 0n) throw new RangeError(`stamp amount must be positive, got ${amount}`);
  if (!Number.isInteger(depth) || depth < minDepth || depth > 255) {
    throw new RangeError(`stamp depth must be a whole number from ${minDepth} to 255, got ${depth}`);
  }
}

/** The up-front price of a batch: `2^depth * amount` PLUR, and the same in BZZ as a decimal string. */
export function stampCost(params: StampParams): { plur: bigint; bzz: string } {
  checkStampParams(params);
  const plur = (1n << BigInt(params.depth)) * params.amount;
  return { plur, bzz: formatBzz(plur) };
}

/** `plur` as BZZ, with up to 16 decimals and no trailing zeros, such as `"1.6777216"`. */
export function formatBzz(plur: bigint): string {
  const sign = plur < 0n ? '-' : '';
  const abs = plur < 0n ? -plur : plur;
  const whole = abs / plurPerBzz;
  const fraction = (abs % plurPerBzz).toString().padStart(16, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * The smallest `amount` Bee accepts at the current price: enough to pay for
 * `minimumValidityBlocks` blocks.
 */
export function minAmount(chain: { currentPrice: bigint; minimumValidityBlocks?: number }): bigint {
  return chain.currentPrice * BigInt(chain.minimumValidityBlocks ?? defaultMinimumValidityBlocks);
}
