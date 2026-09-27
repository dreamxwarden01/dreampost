export type AttachmentState = 'staging' | 'queued' | 'ready';
export type PreviewKind = 'none' | 'pdf' | 'raster';
export interface ExtractedAttachment {
  ordinal: number; filename: string; mimeType: string; disposition: string | null;
  contentId: string | null; sha256: string; sizeBytes: number;
  previewKind: PreviewKind; mediaType: string; bytes: Uint8Array;
}
export interface AttachmentManifestTuple {
  ordinal: number; sha256: string; sizeBytes: number; mimeType: string;
  disposition: string | null; filename: string; contentId: string | null;
}
export interface AttachmentExtraction {
  extractorVersion: number; optionsSha256: string; parts: ExtractedAttachment[];
}
export interface AttachmentItem {
  id: string; filename: string; mimeType: string; sizeBytes: number;
  disposition: string | null; contentId: string | null;
  deliveryKind: 'mime'; state: AttachmentState | 'failed'; previewKind: PreviewKind; sha256: string;
}
export interface AttachmentRecord extends AttachmentItem { deliveryId: string; mailboxId: string; objectKey: string }
export interface AttachmentInventory {
  status: 'pending' | 'complete' | 'unavailable' | 'drift'; errorCode: string | null; items: AttachmentItem[];
}
export interface AttachmentBudget { stageMaxBytes: number; storageMaxBytes: number }
export interface AttachmentStagingStore {
  /** The caller must hold the PostgreSQL object lock while putting or removing a staged object. */
  put(attachmentId: string, sha256: string, bytes: Uint8Array): Promise<void>;
  get(attachmentId: string, sha256: string): Promise<Buffer>;
  remove(attachmentId: string, sha256: string): Promise<void>;
}
export interface UploadTask { id: string; attachmentId: string; leaseId: string; objectKey: string; sha256: string; sizeBytes: number; attempts: number }
export interface UploadReceipt { objectKey: string; sha256: string; sizeBytes: number }
