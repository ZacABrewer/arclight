/**
 * `@arclight/engine-agent`: run Arclight's torrent engine on another machine and drive it over
 * HTTP + WebSocket (see protocol.ts for the endpoints).
 *
 * - `EngineAgentCore` + `handleAgentRequest`: the protocol over a Session, transport-neutral
 *   (the api's engine-agent module serves it through Fastify).
 * - `createAgentServer` / `startAgent`: the standalone node:http agent (`src/main.ts`).
 * - `AgentClient`: the main side's client, used by the `remoteEngine` download client.
 */

export * from './protocol.js';
export {
  AGENT_VERSION,
  AgentError,
  CHECKSUM_CACHE_SIZE,
  describeTorrent,
  EngineAgentCore,
  isInside,
  realpathOfExisting,
  type EngineAgentCoreOptions,
  type FileRange,
} from './core.js';
export {
  errorResponse,
  handleAgentRequest,
  MAX_AGENT_BODY_BYTES,
  presentedToken,
  secretEquals,
  tokenMatches,
  type AgentRequest,
  type AgentResponse,
} from './router.js';
export { createAgentServer, type AgentServer, type AgentServerOptions } from './server.js';
export { AgentClient, AgentClientError, type AgentClientErrorCode, type AgentClientOptions, type AgentSubscription, type SubscribeOptions } from './client.js';
export { AgentConfigError, agentSecurityWarnings, isLoopbackHost, parseAgentEnv, tokenWeakness, type AgentConfig } from './config.js';
export { AuthThrottle, type AuthThrottleOptions } from './throttle.js';
export { LOCKDOWN_ADDRESS, NetworkFollower, type NetworkFollowerOptions } from './network.js';
export { jsonLog, startAgent, type AgentLog, type RunningAgent, type StartAgentOptions } from './agent.js';
export { multipartBoundary, parseMultipart, type FormPart } from './multipart.js';
