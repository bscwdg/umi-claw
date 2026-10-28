export interface VoiceStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string | null): Promise<void>
}

export interface VoiceMetaDatabase {
  metaGet(key: string): Promise<string | null>
  metaSet(key: string, value: string | null): Promise<{ changes: number }>
}

export function createDatabaseVoiceStorage(database: VoiceMetaDatabase): VoiceStorage {
  return {
    get: (key) => database.metaGet(key),
    set: async (key, value) => {
      await database.metaSet(key, value)
    }
  }
}

export class MemoryVoiceStorage implements VoiceStorage {
  private readonly data = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null
  }

  async set(key: string, value: string | null): Promise<void> {
    if (value === null) this.data.delete(key)
    else this.data.set(key, value)
  }
}
