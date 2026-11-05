export { createVoiceManager, VoiceManager } from './core/manager'
export type { VoiceManagerOptions } from './core/manager'
export { VoiceCloneManager } from './core/cloneManager'
export type { VoiceCloneManagerOptions } from './core/cloneManager'
export { VoiceSecretStore } from './secretStore'
export type { SecretEncryption } from './secretStore'
export { createDatabaseVoiceStorage, MemoryVoiceStorage } from './core/storage'
export { createJsonVoiceStorage } from './core/jsonStore'
export type { VoiceStorage, VoiceMetaDatabase } from './core/storage'
export { registerVoiceIpc, VOICE_CHANNELS } from './ipc'
export { getVoiceCatalog, isPresetVoice } from './providers/volcengineCatalog'
export {
  ExternalServiceStore,
  createExternalServiceStore
} from './external/externalServiceStore'
export {
  ExternalVoiceSecretStore,
  createExternalVoiceSecretStore
} from './external/localSecretStore'
export type { ExternalSecretEncryption } from './external/localSecretStore'
export {
  ExternalAvailabilityTracker,
  createExternalAvailabilityTracker
} from './external/availability'
export type {
  ExternalTtsService,
  ExternalTtsServiceInput,
  ExternalTtsServiceView,
  ExternalTtsProbeResult,
  ExternalTtsTestResult
} from './external/types'
export * from './core/types'
export * from './core/errors'
