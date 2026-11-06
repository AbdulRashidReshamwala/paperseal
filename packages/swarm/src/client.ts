/**
 * A small client for the parts of the Bee HTTP API that Paper Seal's backups use
 * (https://docs.ethswarm.org/api/). It is plain `fetch`, so it runs the same in Node and in a
 * browser, against the viewer's own node.
 *
 * Uploads are never encrypted. Every backed-up file is already public and already encrypted or
 * signed, and an encrypted Swarm reference carries its own decryption key, which must never go on
 * Arkiv (spec/arkiv.md, "Backups"). So no request here sets `Swarm-Encrypt`, and a reference that
 * isn't a plain 32-byte address is rejected.
 */
import { checkStampParams, type StampParams } from './stamps';
import { swarm } from './spec';
import { checkCollectionPath, collectionTar, type CollectionFile } from './tar';

/** A Bee request that failed. `status` is the HTTP status, or 0 when no response came back. */
export class SwarmApiError extends Error {
  readonly status: number;
  /** The method and path that failed, such as `GET /wallet`. */
  readonly endpoint: string;

  constructor(status: number, endpoint: string, message: string, options?: { cause?: unknown }) {
    super(`${endpoint}: ${status === 0 ? '' : `${status} `}${message}`, options);
    this.name = 'SwarmApiError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** A download that failed for any reason other than the file not being there. */
export class SwarmReadError extends SwarmApiError {
  constructor(status: number, endpoint: string, message: string, options?: { cause?: unknown }) {
    super(status, endpoint, message, options);
    this.name = 'SwarmReadError';
  }
}

/** How long a read waits for the Bee node, unless the client or the call sets its own. */
export const defaultReadTimeoutMs = 30_000;

/** The longest finite timeout, since `setTimeout` fires at once for anything larger. */
const maxTimeoutMs = 2 ** 31 - 1;

export interface SwarmClientOptions {
  /** The Bee API, such as `http://127.0.0.1:1633`. Defaults to `swarm.defaultApiUrl` in spec/arkiv.json. */
  apiUrl?: string | undefined;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined;
  /**
   * The timeout for reads (`download`, `stamps`, `chainState`, `wallet`, `health` and `addresses`)
   * that don't pass their own, in milliseconds. Defaults to `defaultReadTimeoutMs`; `Infinity`
   * turns it off. Uploads and `buyStamp` never use it.
   */
  timeoutMs?: number | undefined;
}

/** Per-call limits. The timeout covers the whole request, the response body included. */
export interface RequestOptions {
  /** Milliseconds before the request is abandoned, or `Infinity` for no limit. */
  timeoutMs?: number | undefined;
  /** Abandons the request when it aborts. */
  signal?: AbortSignal | undefined;
}

export interface Health {
  status: 'ok' | 'nok' | 'unknown';
  version: string;
  apiVersion: string;
}

export interface Addresses {
  /** The node's Swarm overlay address, 64 hex characters. */
  overlay: string;
  underlay: string[];
  /** The node's own Ethereum address, which pays for stamps. */
  ethereum: string;
  chainAddress: string;
  publicKey: string;
  pssPublicKey: string;
}

export interface Wallet {
  /** In PLUR. */
  bzzBalance: bigint;
  /** In wei: xDAI on mainnet, Sepolia ETH here. */
  nativeTokenBalance: bigint;
  chainId: number;
  walletAddress: string;
  chequebookContractAddress?: string;
}

export interface ChainState {
  chainTip: number;
  /** The last block Bee has processed. 0 until it has synced the postage contract. */
  block: number;
  /** The total PLUR per chunk paid since the contract began. */
  totalAmount: bigint;
  /** PLUR per chunk per block. */
  currentPrice: bigint;
  /** Present on Bee versions that report the contract's minimum batch validity. */
  minimumValidityBlocks?: number;
}

export interface PostageBatch {
  /** 64 lowercase hex characters, no `0x`. */
  batchId: string;
  /** Whether Bee has seen the batch on chain with enough confirmations to stamp with it. */
  usable: boolean;
  label: string;
  depth: number;
  bucketDepth: number;
  /** PLUR per chunk. */
  amount: bigint;
  /** The fullest bucket's chunk count. The batch is full at `2^(depth - bucketDepth)`. */
  utilization: number;
  immutable: boolean;
  exists: boolean;
  /** Seconds until the batch's balance runs out at the current price. */
  ttlSeconds: number;
  blockNumber: number;
}

export interface BuyStampParams extends StampParams {
  label?: string;
}

/**
 * `timeoutMs` has no default here: without `deferred`, Bee answers only once every chunk is on the
 * network, which can take a long time.
 */
export interface UploadOptions extends RequestOptions {
  /** The postage batch to stamp with, 64 lowercase hex characters. */
  batchId: string;
  /**
   * `false`, the default, makes Bee push every chunk to the network before it answers, so the
   * backup survives the uploading node going offline. `true` lets Bee answer once the chunks are
   * stored locally and push them in the background, which is faster but needs the node to stay up.
   */
  deferred?: boolean;
}

export interface SwarmClient {
  /** Uploads `files` as one unencrypted collection and returns its reference. */
  uploadCollection(files: readonly CollectionFile[], options: UploadOptions): Promise<{ reference: string }>;
  /**
   * One file of a collection, or `null` if Bee says it isn't there. Other failures, a timeout
   * included, throw `SwarmReadError`.
   */
  download(reference: string, path: string, options?: RequestOptions): Promise<Uint8Array | null>;
  stamps(options?: RequestOptions): Promise<PostageBatch[]>;
  /**
   * Buys an immutable batch with the node's wallet and returns its ID. Spends BZZ and gas. Bee
   * answers once the purchase is on chain, so there is no default timeout.
   */
  buyStamp(params: BuyStampParams, options?: RequestOptions): Promise<string>;
  chainState(options?: RequestOptions): Promise<ChainState>;
  wallet(options?: RequestOptions): Promise<Wallet>;
  health(options?: RequestOptions): Promise<Health>;
  addresses(options?: RequestOptions): Promise<Addresses>;
}

const hex64 = /^[0-9a-f]{64}$/;

/**
 * Throws unless `reference` is a plain Swarm address: 64 lowercase hex characters with no `0x`.
 * An encrypted reference is 128 characters, so it fails too.
 */
export function checkReference(reference: string): void {
  if (!hex64.test(reference)) {
    throw new TypeError(`a Swarm reference is 64 lowercase hex characters, got ${JSON.stringify(reference)}`);
  }
}

/** Throws unless `batchId` is 64 lowercase hex characters with no `0x`, as backup rows store it. */
export function checkBatchId(batchId: string): void {
  if (!hex64.test(batchId)) {
    throw new TypeError(`a postage batch ID is 64 lowercase hex characters, got ${JSON.stringify(batchId)}`);
  }
}

/** Throws unless `timeoutMs` is `undefined`, `Infinity` or a positive number `setTimeout` can wait for. */
function checkTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined || timeoutMs === Infinity) return;
  if (!(timeoutMs > 0 && timeoutMs <= maxTimeoutMs)) {
    throw new RangeError(`timeoutMs is a positive number of milliseconds up to ${maxTimeoutMs}, or Infinity, got ${timeoutMs}`);
  }
}

export function createSwarmClient(options: SwarmClientOptions = {}): SwarmClient {
  const apiUrl = (options.apiUrl ?? swarm.defaultApiUrl).replace(/\/+$/, '');
  // Wrapped so a browser's `fetch` is never called with a foreign `this`.
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  checkTimeout(options.timeoutMs);
  const readTimeoutMs = options.timeoutMs ?? defaultReadTimeoutMs;

  /** A read's options, with the client's timeout unless the call sets one. */
  function read(call: RequestOptions = {}): RequestOptions {
    return { timeoutMs: call.timeoutMs ?? readTimeoutMs, signal: call.signal };
  }

  /**
   * Sends one request and passes the response to `handle`, inside the timeout and the caller's
   * signal, so a body that stalls is cut off too. A network failure, a timeout or an abort
   * becomes a status-0 error of the given class.
   *
   * The fetch and `handle` are each raced against the abort, so the request ends on time even if
   * a custom `fetch` or a body stream ignores the signal.
   */
  async function request<T>(
    method: string,
    path: string,
    init: RequestInit,
    { timeoutMs, signal }: RequestOptions,
    ErrorClass: typeof SwarmApiError,
    handle: (response: Response, endpoint: string) => Promise<T>,
  ): Promise<T> {
    const endpoint = `${method} ${path}`;
    checkTimeout(timeoutMs);
    const controller = new AbortController();
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason as Error), { once: true });
    });
    aborted.catch(() => {}); // Only ever observed through the races below.

    let timedOut = false;
    const timer =
      timeoutMs === undefined || timeoutMs === Infinity
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort(new DOMException(`no answer within ${timeoutMs} ms`, 'TimeoutError'));
          }, timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const stopped = (cause: unknown) =>
      timedOut
        ? new ErrorClass(0, endpoint, `timed out after ${timeoutMs} ms waiting for the Bee node`, { cause })
        : new ErrorClass(0, endpoint, 'aborted by the caller', { cause });

    try {
      let response: Response;
      try {
        response = await Promise.race([
          doFetch(`${apiUrl}${path}`, { ...init, method, signal: controller.signal }),
          aborted,
        ]);
      } catch (cause) {
        if (controller.signal.aborted) throw stopped(cause);
        throw new ErrorClass(0, endpoint, 'no response from the Bee node', { cause });
      }
      try {
        return await Promise.race([handle(response, endpoint), aborted]);
      } catch (error) {
        if (controller.signal.aborted) throw stopped(error);
        throw error;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Bee's error bodies are `{code, message}`. Falls back to the status text. */
  async function failure(
    response: Response,
    endpoint: string,
    ErrorClass: typeof SwarmApiError = SwarmApiError,
  ): Promise<SwarmApiError> {
    let message = response.statusText;
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body.message === 'string') message = body.message;
    } catch {
      // Not JSON; keep the status text.
    }
    return new ErrorClass(response.status, endpoint, message);
  }

  function json(method: string, path: string, init: RequestInit, call: RequestOptions): Promise<Fields> {
    return request(method, path, init, call, SwarmApiError, async (response, endpoint) => {
      if (!response.ok) throw await failure(response, endpoint);
      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        throw new SwarmApiError(response.status, endpoint, 'response is not JSON', { cause });
      }
      if (!isRecord(body)) throw new SwarmApiError(response.status, endpoint, 'response is not a JSON object');
      return new Fields(body, response.status, endpoint);
    });
  }

  return {
    async uploadCollection(files, { batchId, deferred = false, timeoutMs, signal }) {
      checkBatchId(batchId);
      const tar = await collectionTar(files);
      const body = await json(
        'POST',
        '/bzz',
        {
          // Exactly these headers. `Swarm-Encrypt` is never sent; see the file comment.
          headers: {
            'Content-Type': 'application/x-tar',
            'Swarm-Collection': 'true',
            'Swarm-Postage-Batch-Id': batchId,
            'Swarm-Deferred-Upload': deferred ? 'true' : 'false',
          },
          body: tar,
        },
        { timeoutMs, signal },
      );
      const reference = body.str('reference');
      // A 128-character reference would mean Bee encrypted the upload.
      if (!hex64.test(reference)) throw body.malformed('reference', 'an unencrypted 64-hex reference');
      return { reference };
    },

    async download(reference, path, call) {
      checkReference(reference);
      checkCollectionPath(path);
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      return request('GET', `/bzz/${reference}/${encoded}`, {}, read(call), SwarmReadError, async (response, endpoint) => {
        if (response.status === 404) return null;
        if (!response.ok) throw await failure(response, endpoint, SwarmReadError);
        try {
          return new Uint8Array(await response.arrayBuffer());
        } catch (cause) {
          throw new SwarmReadError(response.status, endpoint, 'body could not be read', { cause });
        }
      });
    },

    async stamps(call) {
      const body = await json('GET', '/stamps', {}, read(call));
      return body.list('stamps').map((stamp) => ({
        batchId: stamp.str('batchID').toLowerCase(),
        usable: stamp.bool('usable'),
        label: stamp.str('label'),
        depth: stamp.num('depth'),
        bucketDepth: stamp.num('bucketDepth'),
        amount: stamp.big('amount'),
        utilization: stamp.num('utilization'),
        immutable: stamp.bool('immutableFlag'),
        exists: stamp.bool('exists'),
        ttlSeconds: stamp.num('batchTTL'),
        blockNumber: stamp.num('blockNumber'),
      }));
    },

    async buyStamp({ amount, depth, label }, call = {}) {
      checkStampParams({ amount, depth });
      const query = label === undefined ? '' : `?label=${encodeURIComponent(label)}`;
      // Immutable, so a full batch refuses new chunks instead of overwriting old ones.
      const body = await json('POST', `/stamps/${amount}/${depth}${query}`, { headers: { Immutable: 'true' } }, call);
      const batchId = body.str('batchID').toLowerCase();
      checkBatchId(batchId);
      return batchId;
    },

    async chainState(call) {
      const body = await json('GET', '/chainstate', {}, read(call));
      const blocks = body.optionalNum('minimumValidityBlocks');
      return {
        chainTip: body.num('chainTip'),
        block: body.num('block'),
        totalAmount: body.big('totalAmount'),
        currentPrice: body.big('currentPrice'),
        ...(blocks === undefined ? {} : { minimumValidityBlocks: blocks }),
      };
    },

    async wallet(call) {
      const body = await json('GET', '/wallet', {}, read(call));
      const chequebook = body.optionalStr('chequebookContractAddress');
      return {
        bzzBalance: body.big('bzzBalance'),
        nativeTokenBalance: body.big('nativeTokenBalance'),
        chainId: body.num('chainID'),
        walletAddress: body.str('walletAddress'),
        ...(chequebook === undefined ? {} : { chequebookContractAddress: chequebook }),
      };
    },

    async health(call) {
      const body = await json('GET', '/health', {}, read(call));
      const status = body.str('status');
      if (status !== 'ok' && status !== 'nok' && status !== 'unknown') {
        throw body.malformed('status', 'ok, nok or unknown');
      }
      return { status, version: body.str('version'), apiVersion: body.str('apiVersion') };
    },

    async addresses(call) {
      const body = await json('GET', '/addresses', {}, read(call));
      return {
        overlay: body.str('overlay'),
        underlay: body.strList('underlay'),
        ethereum: body.str('ethereum'),
        chainAddress: body.str('chain_address'),
        publicKey: body.str('publicKey'),
        pssPublicKey: body.str('pssPublicKey'),
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Typed reads from a JSON object, throwing `SwarmApiError` for a missing or mistyped field. */
class Fields {
  readonly #body: Record<string, unknown>;
  readonly #status: number;
  readonly #endpoint: string;

  constructor(body: Record<string, unknown>, status: number, endpoint: string) {
    this.#body = body;
    this.#status = status;
    this.#endpoint = endpoint;
  }

  malformed(key: string, expected: string): SwarmApiError {
    return new SwarmApiError(this.#status, this.#endpoint, `field ${key} is not ${expected}`);
  }

  str(key: string): string {
    const value = this.#body[key];
    if (typeof value !== 'string') throw this.malformed(key, 'a string');
    return value;
  }

  optionalStr(key: string): string | undefined {
    return this.#body[key] === undefined ? undefined : this.str(key);
  }

  num(key: string): number {
    const value = this.#body[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw this.malformed(key, 'a number');
    return value;
  }

  optionalNum(key: string): number | undefined {
    return this.#body[key] === undefined ? undefined : this.num(key);
  }

  bool(key: string): boolean {
    const value = this.#body[key];
    if (typeof value !== 'boolean') throw this.malformed(key, 'a boolean');
    return value;
  }

  /** Bee sends PLUR and wei amounts as decimal strings, since they pass 2^53. */
  big(key: string): bigint {
    const value = this.str(key);
    if (!/^\d+$/.test(value)) throw this.malformed(key, 'a decimal integer string');
    return BigInt(value);
  }

  strList(key: string): string[] {
    const value = this.#body[key];
    // Bee sends `null` rather than `[]` for an empty list.
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw this.malformed(key, 'a list of strings');
    }
    return value;
  }

  list(key: string): Fields[] {
    const value = this.#body[key];
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value) || !value.every(isRecord)) throw this.malformed(key, 'a list of objects');
    return value.map((item) => new Fields(item, this.#status, this.#endpoint));
  }
}
