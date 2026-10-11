import type { Api, ApiChannel, ApiErrorShape, Bridge } from '@shared/api'

declare global {
  interface Window {
    twok: Bridge
  }
}

/** A failed API call. `code` picks the translated message; `issues` carry setup problems. */
export class ApiError extends Error {
  constructor(readonly shape: ApiErrorShape) {
    super(shape.message)
  }
  get code() {
    return this.shape.code
  }
}

export async function call<K extends ApiChannel>(channel: K, ...args: Parameters<Api[K]>): Promise<ReturnType<Api[K]>> {
  const envelope = await window.twok.invoke(channel, ...args)
  if (!envelope.ok) throw new ApiError(envelope.error)
  return envelope.value
}

export async function openDroppedFile(file: File) {
  const envelope = await window.twok.openDroppedFile(file)
  if (!envelope.ok) throw new ApiError(envelope.error)
  return envelope.value
}
