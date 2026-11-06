import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import type { Hex, Stage } from '@paperseal/protocol';
import type { OutboxMessage, RegistrationEntry, StatusResponse } from '@paperseal/tee-client';

/*
 * A STUB TEE for the local layer of the UI suite, standing at the network boundary of the apps (the
 * apps' VITE_TEE_URL points at it). It answers the public routes of spec/api.md with plain JSON the
 * test sets. It is not a TEE and it never pretends to be:
 *
 *   - Its attestation is the unattested kind a real TEE returns outside Confidential Space: an empty
 *     token and `attested: false`. The apps must refuse it, so every screen that needs a trusted TEE
 *     shows its refusal here. Nothing in this file produces a token, a signature or a receipt.
 *   - It accepts a registration without checking the passkey, which only a real TEE does. Tests that
 *     use it are labelled "[stub tee]".
 *
 * Screens that need real attested answers are run against the deployed TEE (ui/live) instead.
 */

export interface StubState {
  stage: Stage;
  questionCount: number;
  released: Hex[];
  required: number;
  registrations: RegistrationEntry[];
  outbox: OutboxMessage[];
  /** `down` answers 503, `drop` closes the connection, `ok` answers normally. */
  mode: 'ok' | 'down' | 'drop';
  /** `refuse` answers a registration with the TEE's error shape. */
  registerMode: 'accept' | 'refuse';
  /** Seconds the release routes answer 425 `too_early`. */
  releaseOpen: boolean;
}

export interface StubTee {
  url: string;
  state: StubState;
  /** Every request seen, as "METHOD path". */
  seen: string[];
  stop: () => Promise<void>;
}

const hex = (n: number): Hex => `0x${randomBytes(n).toString('hex')}`;

const readJson = (req: IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}') as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });

export async function startStubTee(): Promise<StubTee> {
  const state: StubState = {
    stage: 'onboard',
    questionCount: 0,
    released: [],
    required: 8,
    registrations: [],
    outbox: [],
    mode: 'ok',
    registerMode: 'accept',
    releaseOpen: false,
  };
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify(body));
    };
    const fail = (status: number, code: string, message: string) => send(status, { error: { code, message } });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const path = (req.url ?? '').split('?')[0] ?? '';
    seen.push(`${req.method ?? ''} ${path}`);
    if (state.mode === 'drop') {
      req.socket.destroy();
      return;
    }
    if (state.mode === 'down') {
      fail(503, 'unavailable', 'The stub TEE is switched off for this test.');
      return;
    }
    void (async () => {
      switch (`${req.method ?? ''} ${path}`) {
        case 'GET /v1/status': {
          const status: StatusResponse = {
            stage: state.stage,
            questionCount: state.questionCount,
            release: { released: state.released, required: state.required },
          };
          send(200, status);
          return;
        }
        case 'GET /v1/attestation':
          // What a TEE outside Confidential Space answers: no token, so nothing can be trusted.
          send(200, { token: '', instancePublicKey: hex(65), encryptionPublicKey: hex(65), instanceKeySignature: hex(64), attested: false });
          return;
        case 'GET /v1/registrations':
          send(200, { registrations: state.registrations });
          return;
        case 'GET /v1/outbox':
          send(200, { messages: state.outbox });
          return;
        case 'POST /v1/register/challenge':
          send(200, { challenge: hex(32) });
          return;
        case 'POST /v1/register': {
          const body = await readJson(req);
          if (state.registerMode === 'refuse') {
            fail(400, 'invalid_registration', 'The stub refuses this registration, as a TEE does when a check fails.');
            return;
          }
          state.registrations.push({
            owner: String(body.owner),
            passkeyPublicKey: body.passkeyPublicKey as Hex,
            derivedPublicKey: body.derivedPublicKey as Hex,
            inviteTag: body.inviteTag as Hex,
          });
          send(200, {});
          return;
        }
        case 'POST /v1/release/challenge':
          if (!state.releaseOpen) fail(425, 'too_early', 'The unlock round is not published yet.');
          else send(200, { challenge: hex(32) });
          return;
        default:
          fail(404, 'not_found', `The stub has no ${path}.`);
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub TEE has no port');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    state,
    seen,
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve(); }); }),
  };
}
