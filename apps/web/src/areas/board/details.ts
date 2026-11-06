/*
 * Errors reach the screen as one plain sentence. When the technical reason is worth keeping, it
 * follows the marker and the screen folds it away under "Details".
 */
const marker = '\n\nDetails: ';

/** `say` is what the person reads. `detail` is the original message, for whoever helps them. */
export const withDetails = (say: string, detail: string): string => (detail === '' ? say : `${say}${marker}${detail}`);

export function splitDetails(message: string): { say: string; detail: string | null } {
  const at = message.indexOf(marker);
  return at < 0 ? { say: message, detail: null } : { say: message.slice(0, at), detail: message.slice(at + marker.length) };
}

/** Only the plain sentence, for places that cannot fold anything. */
export const sayOf = (message: string): string => splitDetails(message).say;
