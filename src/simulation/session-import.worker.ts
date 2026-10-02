import { readSessionArchive, type SessionImportResponse } from './session-archive'

self.onmessage = (event: MessageEvent<Uint8Array>) => {
  let response: SessionImportResponse
  try {
    response = { config: readSessionArchive(event.data) }
  } catch (error) {
    response = { error: `Unable to import session ZIP: ${error instanceof Error ? error.message : 'Invalid archive.'}` }
  }
  self.postMessage(response)
}
