import type { AppContext, AppModule } from '../../app.js';
import { finding, healthServiceFor, type HealthCheckDef } from '../health/index.js';
import { requestsServicesFor } from '../requests/index.js';
import type { WebSocketCtor } from './gateway.js';
import type { FetchLike } from './rest.js';
import { discordBotRoutes } from './routes.js';
import { DiscordBotService } from './service.js';

export { DiscordBotService, DiscordBotError, DISCORD_SETTINGS_KEY, LINK_CODE_TTL_MS, DISCONNECTED_GRACE_MS } from './service.js';
export { GatewayClient, GATEWAY_INTENTS, type GatewaySocket, type WebSocketCtor } from './gateway.js';
export { DiscordRest, DiscordRestError, DISCORD_API } from './rest.js';
export { SLASH_COMMANDS, CommandHandler, type DiscordInteraction } from './commands.js';

export const DISCORD_BOT_HEALTH_CHECK = 'DiscordBotDisconnected';

export interface DiscordBotModuleOptions {
  webSocket?: WebSocketCtor;
  fetch?: FetchLike;
  gatewayUrl?: string;
  restBaseUrl?: string;
  now?: () => Date;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const services = new WeakMap<AppContext, DiscordBotService>();

export function discordBotServiceFor(ctx: AppContext, opts: DiscordBotModuleOptions = {}): DiscordBotService {
  let service = services.get(ctx);
  if (!service) {
    service = new DiscordBotService({
      db: ctx.db,
      bus: ctx.bus,
      requests: requestsServicesFor(ctx).requests,
      log: ctx.log.child({ module: 'discord-bot' }),
      ...opts,
    });
    services.set(ctx, service);
  }
  return service;
}

export function discordBotHealthCheck(service: DiscordBotService): HealthCheckDef {
  return {
    id: DISCORD_BOT_HEALTH_CHECK,
    run: async () => {
      const problem = service.healthProblem();
      return problem ? [finding(DISCORD_BOT_HEALTH_CHECK, 'warning', problem, 'discord-bot-disconnected')] : [];
    },
  };
}

/** Discord bot: gateway connection, slash commands, account links and request channel posts. */
export const discordBotModuleWith =
  (opts: DiscordBotModuleOptions = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const service = discordBotServiceFor(ctx, opts);
    await app.register(discordBotRoutes(service));
    const unregister = healthServiceFor(ctx).register(discordBotHealthCheck(service));
    service.start();
    app.addHook('onClose', async () => {
      unregister();
      service.stop();
    });
  };

export const discordBotModule: AppModule = discordBotModuleWith();
