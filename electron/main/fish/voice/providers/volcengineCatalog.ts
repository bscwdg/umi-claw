import rawCatalog from '../../../../../resources/voice/curated-voices.v1.json'
import type { VoiceCatalogFile } from '../core/types'

const catalog = rawCatalog as VoiceCatalogFile

export function getVoiceCatalog(): VoiceCatalogFile {
  return JSON.parse(JSON.stringify(catalog)) as VoiceCatalogFile
}

export function isPresetVoice(speaker: string): boolean {
  return catalog.voices.some((voice) => voice.voiceType === speaker)
}
