/** Shared types for the self-update subsystem. */

export interface Platform {
  os: 'darwin' | 'linux' | 'windows';
  arch: 'arm64' | 'x64';
  musl: boolean;
  /** e.g. "idctl-darwin-arm64" / "idctl-linux-x64-musl" — matches release assets. */
  assetName: string;
}

export interface UpdateInfo {
  version: string; // bare semver, "1.4.2"
  tag: string; // "v1.4.2"
  notesUrl?: string;
  assetUrl: string; // download URL for this platform's asset
  shasumsUrl?: string; // SHASUMS256.txt url (GitHub path)
  sha256?: string; // inline sha (manifest path)
}

export interface PendingUpdate {
  fromVersion: string; // version that staged it (the running build)
  toVersion: string;
  stagedPath: string; // absolute path to verified bytes, same dir as execPath
  sha256: string; // verified hash of stagedPath
  stagedAt: string; // ISO
  notesUrl?: string;
}

export type CheckResult =
  | { status: 'up-to-date'; current: string; checkedAt: number }
  | { status: 'available'; current: string; info: UpdateInfo; checkedAt: number }
  | { status: 'skipped'; reason: 'dev-mode' | 'disabled' | 'cooldown'; checkedAt: number }
  | { status: 'error'; message: string; checkedAt: number };

export interface VerifiedDownload {
  bytes: Buffer;
  sha256: string;
}
