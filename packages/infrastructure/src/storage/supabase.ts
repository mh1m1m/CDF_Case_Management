// SupabaseEvidenceStorage: two private buckets (quarantine, vault) accessed only from server code with the
// service-role key, after the database has authorised the request (ADR-006). storage.objects carries no
// policies for application roles, so the browser can never address an object directly (threat T05).
// PRODUCTION_SUBSTITUTION_REQUIRED: production uses Alibaba OSS with WORM retention and KMS encryption.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EvidenceStorage } from "@cdf/application";
import { EVIDENCE_MAX_BYTES } from "@cdf/contracts";
import { assertObjectKey, QUARANTINE_BUCKET, VAULT_BUCKET } from "./object-key";

export class SupabaseEvidenceStorage implements EvidenceStorage {
  readonly kind = "supabase" as const;
  private readonly client: SupabaseClient;
  private buckets: Promise<void> | undefined;

  constructor(url: string, serviceRoleKey: string) {
    if (!serviceRoleKey)
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for Supabase evidence storage");
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  /** Buckets are private and size-limited; created once per process if missing. */
  private ensureBuckets(): Promise<void> {
    this.buckets ??= (async () => {
      const { data, error } = await this.client.storage.listBuckets();
      if (error) throw new Error(`Storage unavailable: ${error.message}`);
      const existing = new Set((data ?? []).map((b) => b.name));
      for (const name of [QUARANTINE_BUCKET, VAULT_BUCKET]) {
        if (existing.has(name)) continue;
        const created = await this.client.storage.createBucket(name, {
          public: false,
          fileSizeLimit: EVIDENCE_MAX_BYTES,
        });
        if (created.error && !/already exists/i.test(created.error.message))
          throw new Error(`Cannot create bucket ${name}: ${created.error.message}`);
      }
    })().catch((e) => {
      this.buckets = undefined;
      throw e;
    });
    return this.buckets;
  }

  async putQuarantine(objectKey: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.ensureBuckets();
    const key = assertObjectKey(objectKey);
    const { error } = await this.client.storage
      .from(QUARANTINE_BUCKET)
      .upload(key, body as Uint8Array<ArrayBuffer>, { contentType, upsert: false, cacheControl: "0" });
    if (error) throw new Error(`Quarantine upload failed: ${error.message}`);
  }

  async promoteToVault(objectKey: string): Promise<void> {
    const key = assertObjectKey(objectKey);
    if (await this.exists(key)) throw new Error("Vault object already exists");
    const copied = await this.client.storage
      .from(QUARANTINE_BUCKET)
      .copy(key, key, { destinationBucket: VAULT_BUCKET });
    if (copied.error) throw new Error(`Vault promotion failed: ${copied.error.message}`);
    // The quarantine copy is transient; the vault copy is the record and is never removed.
    await this.client.storage.from(QUARANTINE_BUCKET).remove([key]);
  }

  async openReadStream(objectKey: string): Promise<ReadableStream<Uint8Array>> {
    const { data, error } = await this.client.storage.from(VAULT_BUCKET).download(assertObjectKey(objectKey));
    if (error || !data) throw new Error(`Vault download failed: ${error?.message ?? "no data"}`);
    return data.stream() as ReadableStream<Uint8Array>;
  }

  async exists(objectKey: string): Promise<boolean> {
    const key = assertObjectKey(objectKey);
    const folder = key.slice(0, key.lastIndexOf("/"));
    const name = key.slice(key.lastIndexOf("/") + 1);
    const { data, error } = await this.client.storage
      .from(VAULT_BUCKET)
      .list(folder, { search: name, limit: 1 });
    if (error) throw new Error(`Vault lookup failed: ${error.message}`);
    return (data ?? []).some((o) => o.name === name);
  }
}
