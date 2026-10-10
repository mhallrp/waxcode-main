/** The shapes the box's HTTP API actually returns. Kept in one file so a change is easy to find. */

export type InputMode = 'phono' | 'line';

export interface Version {
  version: string;
  /** True when this request came in over the box's own setup network - it knows, we do not guess. */
  onSetupNetwork?: boolean;
}

export interface WifiNetwork {
  ssid: string;
  signal: number;
  secure: boolean;
}

export interface SavedNetwork {
  ssid: string;
  active: boolean;
}

export interface NetworkState {
  /** The network the box is on, or '' when it is on none. */
  connection: string;
  /** With the prefix length, as nmcli reports it: "192.168.1.87/24". */
  ip: string;
  /** 'yes' while the box is running its own setup network. A string, not a boolean - the box's own shell reports it. */
  ap: string;
  serial: string | null;
  name: string | null;
  /** 'no' means this box has never been granted permission to change its own networks. */
  bootstrapped?: string;
  /** False when the credentials were SAVED but the network was not there to join yet. */
  joined?: boolean;
  networks: WifiNetwork[];
  saved: SavedNetwork[];
  /** Why the setup network is up, if it is. */
  lastReason?: string;
  managementDisabled?: boolean;
  /** The setup network's password, or null while it is still open. */
  apPassword: string | null;
  /** true means the setup network is OPEN and the portal must not let anyone past. */
  apOpen: boolean | null;
}

/** Whether the key lock experiment is switched on for this box. Off unless somebody opted in. */
export interface KeyLockFeature { enabled: boolean }

/** Whether this box is asking for a connection PIN, and whether it is switched on at all. */
export interface PinStatus {
  enabled: boolean;
  /** True only when it is on AND this browser has no session - what the lock screen keys off. */
  required: boolean;
  lockedOutForMs?: number;
}

/** Whether an update is waiting, answered from the box's cached check so a page load costs nothing. */
export interface UpdateNotice {
  waiting: boolean;
  /** False until the box has actually asked the feed - the banner stays silent rather than guessing. */
  checked: boolean;
  version: string | null;
  running: string | null;
  dismissed?: boolean;
  showAgainAt?: number | null;
}

/** What the update feed is offering this box, and whether now is a safe moment to take it. */
export interface UpdateState {
  ok: boolean;
  reason?: string;
  detail?: string;
  running: string | null;
  latest: string | null;
  newer: boolean;
  /** False while anything suggests the box is in use - see the server's updateSafety. */
  safe: boolean;
  reasons: string[];
  applying?: string;
}

/** A support session: an outbound tunnel to the box's sshd, open only while someone wants help. */
export interface SupportState {
  active: boolean;
  hostname: string | null;
  secondsRemaining: number;
}

export interface RecordState {
  recording: boolean;
  name: string | null;
  elapsedSeconds: number;
  bytes: number;
  freeBytes: number;
  totalBytes: number;
  remainingSeconds: number;
  hasRecording: boolean;
  /** Non-null only while a copy to the USB stick is running. */
  exporting: { copied: number; total: number } | null;
}

/** Every write the box answers with a named reason rather than a bare failure. */
export interface Refusal {
  ok: false;
  reason: string;
  /** Which input was at fault, when one was. */
  field?: string;
  detail?: string;
  /** How long before retrying is worth it, when the box is throttling rather than disagreeing. */
  retryInMs?: number;
}

export type Result<T> = ({ ok: true } & T) | Refusal;

export type DeckNumber = 1 | 2;

/** Everything xwax reports, as the status stream sends it. Fields a newer xwax added are optional. */
export interface DeckStatus {
  state: 'PLAYING' | 'STOPPED' | 'EMPTY' | 'IMPORTING' | string;
  remain: number;
  pitch: number;
  /** Relative tracking. The UI calls the INVERSE of this "Position lock". */
  relative: boolean;
  cuePoint: number;
  loopActive: boolean;
  loopStart: number;
  loopEnd: number;
  elapsed: number | null;
  /** Needle down and reading a locked position. null from an xwax that predates the field. */
  timecodeValid: boolean | null;
  /** Seconds turning without a decodable position - a mismatched timecode side looks like this. */
  unreadableSeconds: number | null;
  keyLock: boolean | null;
  path: string | null;
  sentAt?: number;
}

/** What the box believes a deck is set to, which is not always what xwax reports. */
export interface DeckSettings {
  passthrough: boolean;
  relative: boolean;
  keyLock: boolean;
  timecodeSide: string;
  sensitivity: number;
  inputMode: InputMode;
}

export interface Track {
  path: string;
  title: string;
  artist: string;
  bpm?: number | null;
  duration?: number | null;
}

export interface Device {
  id: string;
  name: string;
  /** Absolute mount path. Every track's path starts with this. */
  root: string;
  /** Stable per-stick id. Favourites belong to the stick, not the port it happens to be in. */
  volumeId: string;
  scanning: boolean;
  tracks: Track[];
  /** What the stick is formatted as, from /proc/mounts - vfat, exfat, ntfs3, hfsplus. */
  fsType?: string | null;
  /** Every directory on the stick, relative to its root. */
  folders?: string[];
}

/** A favourite is a FOLDER, not a track - the crate you are standing in. */
export interface Favourite {
  volumeId: string;
  path: string;
}

/** Tracks staged on the box after being sent from a laptop - see the server's uploads.js. */
export interface UploadState {
  tracks: { name: string; bytes: number; path: string }[];
  usedBytes: number;
  availableBytes: number;
  maxFileBytes: number;
}

