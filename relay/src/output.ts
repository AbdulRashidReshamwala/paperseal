/*
 * Everything the relay prints goes through here, so a secret it holds can never reach the
 * terminal. The Arkiv access key is the only secret this process registers: it rides in the RPC
 * URL's path, and viem puts that URL into its error messages. The signing key is never registered
 * because it never reaches any text this process prints (see keystore.ts).
 */

const secrets = new Set<string>();

/** Hides `secret`, and its URL-encoded form, in everything printed from now on. */
export function registerSecret(secret: string | undefined): void {
  if (!secret) return;
  secrets.add(secret);
  secrets.add(encodeURIComponent(secret));
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : '';
    return redact(`${error.name}: ${error.message}${cause}`);
  }
  return redact(String(error));
}

export const print = (line = ''): void => {
  console.log(redact(line));
};

export const printError = (line: string): void => {
  console.error(redact(line));
};
