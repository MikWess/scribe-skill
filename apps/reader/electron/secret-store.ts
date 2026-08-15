import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ProviderName = "openai" | "elevenlabs";

export function parseProviderName(value: unknown): ProviderName {
  if (value !== "openai" && value !== "elevenlabs") throw new Error("Unknown voice provider");
  return value;
}

export function isTrustedRendererUrl(value: string): boolean {
  return value.startsWith("scribe-skill://app/");
}

type EncryptedSecrets = Partial<Record<ProviderName, string>>;

export interface SecureStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class ProviderSecretStore {
  private readonly filePath: string;
  private readonly secureStorage: SecureStorageAdapter;
  private pendingMutation: Promise<void> = Promise.resolve();

  constructor(filePath: string, secureStorage: SecureStorageAdapter) {
    this.filePath = filePath;
    this.secureStorage = secureStorage;
  }

  available(): boolean {
    return this.secureStorage.isEncryptionAvailable();
  }

  private async readEncrypted(): Promise<EncryptedSecrets> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as EncryptedSecrets;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeEncrypted(secrets: EncryptedSecrets): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.filePath);
  }

  async get(provider: ProviderName): Promise<string | undefined> {
    const encrypted = (await this.readEncrypted())[provider];
    if (!encrypted) return undefined;
    if (!this.available()) throw new Error("Operating-system secure storage is unavailable");
    return this.secureStorage.decryptString(Buffer.from(encrypted, "base64"));
  }

  async has(provider: ProviderName): Promise<boolean> {
    return Boolean((await this.readEncrypted())[provider]);
  }

  async set(provider: ProviderName, value: string): Promise<void> {
    if (!this.available()) throw new Error("Operating-system secure storage is unavailable");
    if (!value.trim()) throw new Error("API key cannot be empty");
    await this.mutate(async (secrets) => {
      secrets[provider] = this.secureStorage.encryptString(value.trim()).toString("base64");
    });
  }

  async delete(provider: ProviderName): Promise<void> {
    await this.mutate(async (secrets) => {
      delete secrets[provider];
    });
  }

  private async mutate(change: (secrets: EncryptedSecrets) => Promise<void>): Promise<void> {
    const mutation = this.pendingMutation.then(async () => {
      const secrets = await this.readEncrypted();
      await change(secrets);
      await this.writeEncrypted(secrets);
    });
    this.pendingMutation = mutation.catch(() => undefined);
    await mutation;
  }
}
