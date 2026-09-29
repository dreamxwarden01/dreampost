export interface AddressView {
  allocationId: string; address: string; ownerPaused: boolean; adminPaused: boolean;
  receiveOnly: boolean; current: boolean; systemPaused: boolean; policyAcknowledged: boolean;
  receiveEnabled: boolean; mailboxId: string; mailboxName?: string; ownerUsername?: string | null;
  policyStatus?: string; policyError?: string | null;
}
export interface RequestView { id: string; address: string; status: string; requesterName?: string; }
export interface AddressesResponse {
  mailbox: { id: string; provisioning_status: string } | null;
  addresses: AddressView[];
  requests: RequestView[];
}
