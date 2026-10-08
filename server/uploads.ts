import { getStore } from '@edgeone/pages-blob';

export interface UploadStore {
  createUploadUrl(key: string): Promise<{ url: string }>;
  read(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

export function makersUploads(): UploadStore {
  const store = getStore('checkin-imports');
  return {
    createUploadUrl: key => store.createUploadUrl(key, { expireSeconds: 300, contentType: 'application/octet-stream' }),
    read: key => store.get(key, { type: 'arrayBuffer', consistency: 'strong' }),
    delete: key => store.delete(key),
  };
}
