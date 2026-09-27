import type { JWK } from 'jose';
import type { Actor } from './service.js';

export interface AuthConfig {
  issuer: string;
  clientId: string;
  clientName?: string;
  publicBaseUrl: string;
  clientPrivateJwk: JWK;
  internalBaseUrl?: string;
  accountPortalUrl?: string;
  allowInsecureLocal?: boolean;
  sessionIdleSeconds?: number;
  sessionMaxSeconds?: number;
}

export interface AuthOptions {
  onLogin?: (actor: Actor) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}

export const AUTH_PERMISSIONS = ['mailbox.use', 'mail.send', 'mail.manage', 'addresses.manage', 'roles.manage'] as const;
export const SESSION_COOKIE = 'dreampost_session';
export const SECURE_SESSION_COOKIE = '__Host-dreampost_session';
export const FLOW_COOKIE_PREFIX = 'dreampost_flow_';
export const SECURE_FLOW_COOKIE_PREFIX = '__Host-dreampost_flow_';
