import type { PoolClient } from 'pg';

export interface AddressActor {
  principalId: string;
  issuer: string;
  subject: string;
  username: string;
  roleId: number;
  permissions: ReadonlySet<string>;
}
export type ResolvePrincipal = (principalId: string, client?: PoolClient) => Promise<AddressActor>;
export interface AddressConfig { defaultDomain: string; managedDomains: readonly string[]; reservedLocalParts?: readonly string[] }
export interface PersonalMailbox {
  id: string;
  address: string;
  name: string;
  mailbox_type: 'personal' | 'shared';
  owner_principal_id: string | null;
  enabled: boolean;
  provisioning_status: 'ready' | 'needs_address' | 'pending_activation';
  provisioning_code: string | null;
}
export interface AllocationRow {
  id: string;
  address: string;
  mailbox_id: string;
  source: string;
  receive_only: boolean;
  send_generation: string;
  ended_at: Date | null;
}
export interface AddressRequestRow {
  id: string;
  requester_id: string;
  mailbox_id: string;
  address: string;
  action: 'add' | 'reactivate';
  status: 'pending' | 'approved' | 'rejected';
  allocation_id: string | null;
  decision_reason: string;
}
export interface AddressView {
  allocationId: string;
  address: string;
  mailboxId: string;
  current: boolean;
  receiveOnly: boolean;
  ownerPaused: boolean;
  adminPaused: boolean;
  systemPaused: boolean;
  receiveEnabled: boolean;
  policyRevision: number;
  policyAcknowledged: boolean;
  policyStatus: string;
  policyError: string | null;
  sendingGeneration: number;
}
export interface SenderEligibility {
  eligible: boolean;
  reason: string | null;
  allocationId: string;
  mailboxId?: string;
  address?: string;
  grantId?: string;
  sendingGeneration?: number;
  policyRevision?: number;
  policyDigest?: string;
}
