/**
 * Process-wide "the user already confirmed quitting" flag. While it is false the
 * window close / before-quit interceptors ask first; once set, every quit path
 * (single-instance loser, confirmed close, home change, full reset) goes through
 * without asking again. Lives in its own module because several main-process
 * modules write it and an imported `let` binding cannot be reassigned.
 */
let allowQuit = false;

export function isQuitAllowed(): boolean {
  return allowQuit;
}

export function setAllowQuit(): void {
  allowQuit = true;
}
