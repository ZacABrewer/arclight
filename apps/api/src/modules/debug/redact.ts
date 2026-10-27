import { redactText } from '@arclight/shared';
import { maskSecrets } from '../config-export/secrets.js';

// Redaction for everything the debug console prints. Structured values go through the
// config-export key-name rule (maskSecrets) first; the final text then goes through the shared
// redactText (packages/shared/src/redact.ts), which catches secrets inside free text (log
// messages, URLs, headers).

export { maskSecrets, redactText };

/** Structured value → JSON text with secret keys masked, then free-text redaction. */
export function redactJson(value: unknown): string {
  return redactText(JSON.stringify(maskSecrets(value)));
}
