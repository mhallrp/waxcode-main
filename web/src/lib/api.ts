import type {
  DeckNumber, DeckSettings, Device, Favourite, NetworkState, RecordState, Refusal, Version,
  InputMode, UploadState, SupportState, UpdateState, UpdateNotice, PinStatus, KeyLockFeature,
} from '../types';

/** Every call to the box, in one place and typed. */

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return res.json() as Promise<T>;
}

/** A write, where a refusal is an ANSWER rather than an exception. */
async function post<T>(path: string, body?: unknown): Promise<({ ok: true } & T) | Refusal> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // The box went away mid-request, which on the setup network is a normal thing to survive.
    return { ok: false, reason: 'unreachable', detail: (err as Error).message };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, ...data } as { ok: true } & T;
  return { ok: false, reason: 'unknown', ...data } as Refusal;
}

export const api = {
  version: () => get<Version>('/version'),

  inputMode: () => get<{ mode: InputMode }>('/input-mode'),
  setInputMode: (mode: InputMode) => post<{ mode: InputMode }>('/input-mode', { mode }),

  network: () => get<NetworkState>('/network'),
  /** `saved` without `joined` means the credentials are kept and NetworkManager will connect when that network next appears */
  joinNetwork: (body: { ssid: string; psk: string; adminPassword?: string; boxName?: string }) =>
    post<NetworkState>('/network', body),
  forgetNetwork: (ssid: string) => post<object>('/network/forget', { ssid }),
  setApPassword: (apPassword: string) => post<object>('/network/ap-password', { apPassword }),

  record: () => get<RecordState>('/record'),
  recordCommand: (command: 'start' | 'stop' | 'export' | 'purge') =>
    post<RecordState>('/record', { command }),

  /** Updates the box fetches for ITSELF, so the app is no longer needed to deliver them. */
  keyLockFeature: () => get<KeyLockFeature>('/key-lock'),
  setKeyLockFeature: (enabled: boolean) => post<{ enabled: boolean }>('/key-lock', { enabled }),

  pinStatus: () => get<PinStatus>('/pin'),
  unlockPin: (pin: string) => post<{ ok: boolean; reason?: string; retryInMs?: number }>('/pin/unlock', { pin }),
  setPin: (next: { enabled?: boolean; pin?: string }) =>
    post<{ ok: boolean; reason?: string; enabled?: boolean }>('/pin', next),

  /** Instant: the box answers from a cached check. */
  updateNotice: () => get<UpdateNotice>('/update/notice'),
  dismissUpdate: (version: string) => post<object>('/update/notice', { version }),

  update: () => get<UpdateState>('/update'),
  applyUpdate: () => post<UpdateState>('/update'),

  sendDiagnostics: () => post<{ reference: string }>('/diagnostics'),

  /** A support session. */
  support: () => get<SupportState>('/support-tunnel'),
  startSupport: () => post<SupportState>('/support-tunnel'),
  stopSupport: () =>
    fetch('/support-tunnel', { method: 'DELETE' })
      .then((res) => ({ ok: res.ok }))
      .catch(() => ({ ok: false })),

  library: () => get<{ devices: Device[] }>('/library'),

  uploads: () => get<UploadState>('/uploads'),
  /** The File itself as the body, not multipart */
  sendUpload: (file: File, onProgress: (fraction: number) => void) =>
    new Promise<({ ok: true; path: string }) | Refusal>((resolve) => {
      const request = new XMLHttpRequest();
      request.open('POST', `/uploads?name=${encodeURIComponent(file.name)}`);
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      });
      request.addEventListener('load', () => {
        if (request.status >= 200 && request.status < 300) {
          /* The box says where it staged the file; the client must never guess that path. */
          let path = '';
          try { path = JSON.parse(request.responseText).path ?? ''; } catch { /* reported below */ }
          if (path) resolve({ ok: true, path });
          else resolve({ ok: false, reason: 'unknown', detail: 'the box did not say where it put the file' });
          return;
        }
        let detail = `HTTP ${request.status}`;
        try { detail = JSON.parse(request.responseText).error ?? detail; } catch { /* keep the status */ }
        resolve({ ok: false, reason: 'unknown', detail });
      });
      request.addEventListener('error', () => resolve({ ok: false, reason: 'unreachable' }));
      request.addEventListener('abort', () => resolve({ ok: false, reason: 'unreachable' }));
      request.send(file);
    }),
  deleteUpload: (name: string) =>
    fetch(`/uploads/${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then((res) => ({ ok: res.ok }))
      .catch(() => ({ ok: false })),
  /** Asks the box to drop its own network, look around, and put it back. */
  rescanNetworks: () => post<{ seconds: number }>('/network/rescan'),
  /** A chosen order for one folder's tracks, kept on the stick that holds them. */
  trackOrder: (device: string, folder: string) =>
    get<{ names: string[] }>(`/order?device=${encodeURIComponent(device)}&folder=${encodeURIComponent(folder)}`),
  setTrackOrder: (device: string, folder: string, names: string[]) =>
    post<object>(`/order?device=${encodeURIComponent(device)}&folder=${encodeURIComponent(folder)}`, { names }),

  /** Deleting from the stick. */
  deleteStickTrack: (device: string, path: string) =>
    fetch(`/stick/track?device=${encodeURIComponent(device)}&path=${encodeURIComponent(path)}`, { method: 'DELETE' })
      .then(async (res) => (res.ok ? { ok: true as const } : { ok: false as const, detail: (await res.json().catch(() => ({}))).error }))
      .catch(() => ({ ok: false as const, detail: 'the box could not be reached' })),

  deleteStickFolder: (device: string, path: string) =>
    fetch(`/stick/folder?device=${encodeURIComponent(device)}&path=${encodeURIComponent(path)}`, { method: 'DELETE' })
      .then(async (res) => (res.ok ? { ok: true as const } : { ok: false as const, detail: (await res.json().catch(() => ({}))).error }))
      .catch(() => ({ ok: false as const, detail: 'the box could not be reached' })),

  /** Adding to the stick itself. */
  makeStickFolder: (device: string, folder: string, name: string) =>
    post<{ name: string }>(`/stick/folder?device=${encodeURIComponent(device)}&folder=${encodeURIComponent(folder)}`, { name }),

  /** XHR again: fetch cannot report how much of a REQUEST has gone out */
  addStickTrack: (device: string, folder: string, file: File, onProgress: (fraction: number) => void) =>
    new Promise<{ ok: true } | Refusal>((resolve) => {
      const request = new XMLHttpRequest();
      request.open('POST', `/stick/track?device=${encodeURIComponent(device)}`
        + `&folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`);
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      });
      request.addEventListener('load', () => {
        if (request.status >= 200 && request.status < 300) { resolve({ ok: true }); return; }
        let detail = `HTTP ${request.status}`;
        try { detail = JSON.parse(request.responseText).error ?? detail; } catch { /* keep the status */ }
        resolve({ ok: false, reason: 'unknown', detail });
      });
      request.addEventListener('error', () => resolve({ ok: false, reason: 'unreachable' }));
      request.addEventListener('abort', () => resolve({ ok: false, reason: 'unreachable' }));
      request.send(file);
    }),

  favourites: () => get<{ favourites: Favourite[] }>('/favourites'),
  /** The box answers with the list AFTER the write, so the caller can trust what comes back rather than guessing */
  setFavourite: (volumeId: string, path: string, on: boolean) =>
    post<{ favourites: Favourite[] }>('/favourites', { volumeId, path, on }),

  deck: (n: DeckNumber) => ({
    state: () => get<DeckSettings>(`/decks/${n}/state`),
    load: (path: string) => post<object>(`/decks/${n}/load`, { path }),
    play: () => post<object>(`/decks/${n}/play`),
    pause: () => post<object>(`/decks/${n}/pause`),
    cue: () => post<object>(`/decks/${n}/cue`),
    cuePlay: () => post<object>(`/decks/${n}/cue/play`),
    setCue: (seconds: number) => post<object>(`/decks/${n}/cue/set`, { seconds }),
    seek: (seconds: number) => post<object>(`/decks/${n}/seek`, { seconds }),
    /** The box's flag is `relative`; the UI calls its INVERSE "Position lock". */
    setPositionLock: (on: boolean) => post<object>(`/decks/${n}/relative`, { on: !on }),
    setKeyLock: (on: boolean) => post<object>(`/decks/${n}/keylock`, { on }),
    setPassthrough: (on: boolean) => post<object>(`/decks/${n}/passthrough`, { on }),
    setTimecodeSide: (side: string) => post<object>(`/decks/${n}/timecode-side`, { side }),
    setLoop: (start: number, end: number) => post<object>(`/decks/${n}/loop`, { start, end }),
    clearLoop: () => post<object>(`/decks/${n}/loop`, { clear: true }),
    /** relocate, NOT seek: seek always pauses, and moving into a loop has to preserve whatever play state already held. */
    relocate: (seconds: number) => post<object>(`/decks/${n}/relocate`, { seconds }),
  }),
};
