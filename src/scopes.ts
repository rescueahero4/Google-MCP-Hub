// Every Google permission the hub can ask for, in one place for review.
// A preset is picked per account at connect time.

const G = "https://www.googleapis.com/auth";

export const PRESETS = {
  "read-only": [
    `${G}/gmail.readonly`,
    `${G}/drive.readonly`,
    `${G}/spreadsheets.readonly`,
    `${G}/documents.readonly`,
    `${G}/calendar.readonly`,
  ],
  // gmail.modify can read, label, draft and send, but cannot permanently delete mail.
  "read-write": [
    `${G}/gmail.modify`,
    `${G}/drive`,
    `${G}/spreadsheets`,
    `${G}/documents`,
    `${G}/calendar`,
  ],
} as const;

export type Preset = keyof typeof PRESETS;

export const IDENTITY_SCOPES = ["openid", "email"];

export function isPreset(value: string): value is Preset {
  return Object.hasOwn(PRESETS, value);
}
