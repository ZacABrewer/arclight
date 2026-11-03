import { z } from 'zod';
import { ContentRestrictions } from './requests.js';
import { ThemeName } from './theme-name.js';

/** Profiles per account, the owner profile included. */
export const HOUSEHOLD_PROFILES_MAX = 12;
/** Avatar colours offered in the editor (the first four are the design's). */
export const HOUSEHOLD_PROFILE_COLORS = ['#7c6cf0', '#e0913a', '#3aa37a', '#e5484d', '#3a8fd9', '#d0569b', '#b8a23a', '#8a94a3'] as const;

export const HouseholdProfileId = z.number().int().positive();
export const ProfileName = z.string().trim().min(1).max(24);
export const ProfileColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** Four digits. Stored as a scrypt hash; never returned. */
export const ProfilePin = z.string().regex(/^\d{4}$/);
export const SubtitleSize = z.enum(['small', 'medium', 'large']);
export type SubtitleSize = z.infer<typeof SubtitleSize>;
export const FocusStyle = z.enum(['white-frame', 'cyan-glow']);
export type FocusStyle = z.infer<typeof FocusStyle>;
/** ISO 639-1 (or 639-2 when there is no 639-1 code), lower case. */
export const ProfileLanguageCode = z.string().regex(/^[a-z]{2,3}$/);

/** Player settings that follow the profile on every device. */
export const ProfileSettings = z.object({
  /** null: subtitles off. */
  subtitleLanguage: ProfileLanguageCode.nullable().default(null),
  subtitleSize: SubtitleSize.default('medium'),
  /** Preferred audio language; null: the file's default track. */
  audioLanguage: ProfileLanguageCode.nullable().default(null),
  autoplayNext: z.boolean().default(true),
  skipIntros: z.boolean().default(false),
  heroRotate: z.boolean().default(true),
  reduceMotion: z.boolean().default(false),
  showMusic: z.boolean().default(true),
  showAudiobooks: z.boolean().default(true),
  focusStyle: FocusStyle.default('white-frame'),
  /** Player theme for this profile; null: `cinema` (the redesign's look). See §4.1. */
  theme: ThemeName.nullable().default(null),
});
export type ProfileSettings = z.infer<typeof ProfileSettings>;

/** Partial update (no defaults, so absent keys stay as they are). */
export const ProfileSettingsPatch = z.object({
  subtitleLanguage: ProfileLanguageCode.nullable().optional(),
  subtitleSize: SubtitleSize.optional(),
  audioLanguage: ProfileLanguageCode.nullable().optional(),
  autoplayNext: z.boolean().optional(),
  skipIntros: z.boolean().optional(),
  heroRotate: z.boolean().optional(),
  reduceMotion: z.boolean().optional(),
  showMusic: z.boolean().optional(),
  showAudiobooks: z.boolean().optional(),
  focusStyle: FocusStyle.optional(),
  theme: ThemeName.nullable().optional(),
});
export type ProfileSettingsPatch = z.infer<typeof ProfileSettingsPatch>;

export const HouseholdProfile = z.object({
  id: HouseholdProfileId,
  name: ProfileName,
  color: ProfileColor,
  /** One or two characters shown in the avatar (first letter of the name, upper-cased, by default). */
  initial: z.string().min(1).max(2),
  /** The account's own profile: cannot be deleted, cannot have its own content limit. */
  isOwner: z.boolean(),
  hasPin: z.boolean(),
  /** The profile's own limit, combined with the account's (the stricter wins). null: only the account's. */
  contentRestrictions: ContentRestrictions.nullable(),
  settings: ProfileSettings,
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HouseholdProfile = z.infer<typeof HouseholdProfile>;

/** GET /households/profiles (any credential of the account, any active profile). */
export const HouseholdProfilesResponse = z.object({
  profiles: z.array(HouseholdProfile),
  activeProfileId: HouseholdProfileId,
  /** The owner profile is active, so create / edit / delete is allowed. */
  canManage: z.boolean(),
  max: z.number().int(),
});
export type HouseholdProfilesResponse = z.infer<typeof HouseholdProfilesResponse>;

/** POST /households/profiles and POST /users/:userId/profiles. */
export const HouseholdProfileCreate = z.object({
  name: ProfileName,
  color: ProfileColor.optional(),
  initial: z.string().trim().min(1).max(2).optional(),
  contentRestrictions: ContentRestrictions.nullable().optional(),
  pin: ProfilePin.nullable().optional(),
  settings: ProfileSettingsPatch.optional(),
});
export type HouseholdProfileCreate = z.infer<typeof HouseholdProfileCreate>;

/** PATCH /households/profiles/:id and PATCH /users/:userId/profiles/:id. `pin: null` removes the PIN. */
export const HouseholdProfileUpdate = z.object({
  name: ProfileName.optional(),
  color: ProfileColor.optional(),
  initial: z.string().trim().min(1).max(2).optional(),
  contentRestrictions: ContentRestrictions.nullable().optional(),
  pin: ProfilePin.nullable().optional(),
  settings: ProfileSettingsPatch.optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});
export type HouseholdProfileUpdate = z.infer<typeof HouseholdProfileUpdate>;

/** POST /households/profiles/:id/select. */
export const SelectProfileRequest = z.object({ pin: ProfilePin.optional() });
export type SelectProfileRequest = z.infer<typeof SelectProfileRequest>;
export const SelectProfileResponse = z.object({ activeProfile: HouseholdProfile });
export type SelectProfileResponse = z.infer<typeof SelectProfileResponse>;

/** Error body for every households route (and the hook's profile confinement). */
export const HouseholdErrorCode = z.enum([
  'pin-required', 'pin-wrong', 'pin-locked', 'unsupported-credential', 'not-found',
  'profile-forbidden', 'limit-reached', 'owner-immutable', 'manage-forbidden',
]);
export type HouseholdErrorCode = z.infer<typeof HouseholdErrorCode>;
export const HouseholdError = z.object({
  error: HouseholdErrorCode,
  /** With 'pin-locked': seconds until another try is allowed. */
  retryAfterSeconds: z.number().int().optional(),
});
export type HouseholdError = z.infer<typeof HouseholdError>;

/** The active profile as the auth "me" response and the app shell carry it. */
export const ActiveProfileSummary = z.object({
  id: HouseholdProfileId,
  name: ProfileName,
  color: ProfileColor,
  initial: z.string(),
  isOwner: z.boolean(),
});
export type ActiveProfileSummary = z.infer<typeof ActiveProfileSummary>;
