import type { AppModule } from '../../app.js';
import { configRoutes } from './routes.js';
import { configServiceFor } from './service.js';

export { ConfigService, configServiceFor, type ConfigServiceOptions } from './service.js';
export { buildDocument, importDocument, planImport, type ImportOutcome, type ImportOptions } from './engine.js';
export { CONFIG_FILE_ENV, SETTING_ENV_PREFIX, parseConfigText, toYaml } from './overlay.js';
export { isSecretKey, maskSecrets } from './secrets.js';
export { EXPORT_SECRETS_CONFIRMATION } from './routes.js';

// Config as code: GET /config/export, POST /config/import and /config/validate, and the boot
// overlay (ARCLIGHT_CONFIG_FILE in managed mode, then ARCLIGHT_SETTING__* overrides). The
// overlay runs while the module registers, i.e. before any onReady hook starts engines or jobs,
// so register this module early (right after settingsModule). See docs/OPERATIONS.md.
export const configExportModule: AppModule = (ctx) => async (app) => {
  const service = configServiceFor(ctx);
  service.applyBootOverlay();
  service.watch();
  await app.register(configRoutes(service));
  app.addHook('onClose', async () => service.stop());
};
