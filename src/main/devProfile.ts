/**
 * Unpackaged builds (`npm run dev`, `electron .`) get their own profile.
 *
 * Without this a dev build shares userData with the installed app: the same
 * config.json, so the same harnessHome, so the same hive and the same hook pipe
 * (its name is a hash of the hive root). A dev build then archives the real
 * floor's agents, regenerates its docs from unreleased code, and fights the
 * installed app for the hook pipe. Electron's single-instance lock is also keyed
 * on userData, so with separate profiles both can run side by side.
 *
 * MUST be the first import of index.ts: everything below it reads userData
 * lazily, and Electron only honours setPath('userData') before first use.
 *
 * Set MUNDER_DIFFLIN_PROFILE=default to run a dev build against the real profile.
 * An explicit --user-data-dir (test drivers, throwaway profiles) is left alone.
 */
import { app } from 'electron';

export const DEV_PROFILE_SUFFIX = '-dev';

if (
  !app.isPackaged &&
  process.env.MUNDER_DIFFLIN_PROFILE !== 'default' &&
  !app.commandLine.hasSwitch('user-data-dir')
) {
  app.setPath('userData', `${app.getPath('userData')}${DEV_PROFILE_SUFFIX}`);
}
