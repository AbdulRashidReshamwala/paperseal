import { createSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/*
 * MOCK ATTESTATION. A real token is signed by Google's Confidential Space root. This one is signed by a
 * three-certificate chain made here with the `openssl` command, with a root that exists only for one run.
 * The apps trust that root only in their `mock` mode (apps/*\/src/mockMode.ts). The token's claims have the
 * real shape, so every claim check in @paperseal/attestation still runs for real. Only the root differs.
 */

export interface MockPki {
  /** The root certificate, DER. The apps' mock mode is given this as `VITE_MOCK_TRUST_ROOT`, in base64. */
  rootDer: Uint8Array;
  /** An RS256 JWT whose header carries `x5c`: leaf, intermediate, root. */
  mint: (claims: Record<string, unknown>) => string;
  stop: () => void;
}

function openssl(args: string[], cwd: string): void {
  const run = spawnSync('openssl', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`openssl ${args.slice(0, 2).join(' ')} failed: ${run.stderr}`);
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');
const pemToDer = (pem: string) => Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');

export function makeMockPki(): MockPki {
  const dir = mkdtempSync(resolve(tmpdir(), 'paperseal-mock-pki-'));
  const ca = 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n';
  const leafExt = 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n';
  writeFileSync(resolve(dir, 'ca.ext'), ca);
  writeFileSync(resolve(dir, 'leaf.ext'), leafExt);
  for (const name of ['root', 'int', 'leaf']) openssl(['genrsa', '-out', `${name}.key`, '2048'], dir);
  openssl(['req', '-x509', '-new', '-key', 'root.key', '-days', '3', '-subj', '/CN=Paper Seal Mock Root', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', 'root.pem'], dir);
  for (const [name, subject, ext, issuer] of [
    ['int', '/CN=Paper Seal Mock Intermediate', 'ca.ext', 'root'],
    ['leaf', '/CN=Paper Seal Mock Machine', 'leaf.ext', 'int'],
  ] as const) {
    openssl(['req', '-new', '-key', `${name}.key`, '-subj', subject, '-out', `${name}.csr`], dir);
    openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-CAcreateserial', '-days', '3', '-extfile', ext, '-out', `${name}.pem`], dir);
  }
  // A certificate is valid from its second of issue, and a token's iat is read as of that second. Let one pass.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
  const certs = ['leaf', 'int', 'root'].map((name) => pemToDer(readFileSync(resolve(dir, `${name}.pem`), 'utf8')));
  const leafKey = readFileSync(resolve(dir, 'leaf.key'), 'utf8');
  return {
    rootDer: new Uint8Array(certs[2] as Buffer),
    mint: (claims) => {
      const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', x5c: certs.map((der) => der.toString('base64')) }));
      const body = b64url(JSON.stringify(claims));
      const signature = createSign('RSA-SHA256').update(`${header}.${body}`).sign(leafKey).toString('base64url');
      return `${header}.${body}.${signature}`;
    },
    stop: () => rmSync(dir, { recursive: true, force: true }),
  };
}
