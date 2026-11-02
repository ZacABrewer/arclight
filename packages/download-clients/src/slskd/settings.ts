import { z } from 'zod';
import { hostField, portField, urlBaseField, useSslField } from '../http.js';

/** Connection settings for an slskd instance (the Soulseek client daemon with a web API). */
export const SlskdSettings = z.object({
  host: hostField,
  port: portField(5030),
  useSsl: useSslField,
  urlBase: urlBaseField('/slskd'),
  apiKey: z
    .string()
    .trim()
    .default('')
    .describe('An API key from the web.authentication.api_keys section of the slskd configuration. Write-only.'),
});
export type SlskdSettings = z.infer<typeof SlskdSettings>;
export type SlskdSettingsInput = z.input<typeof SlskdSettings>;
