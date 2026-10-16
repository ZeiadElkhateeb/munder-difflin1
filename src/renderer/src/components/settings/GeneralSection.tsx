/**
 * Settings → General: language, theme, terminal, notifications, updates, privacy.
 */
import { PixelButton } from '../PixelButton';
import { UpdatesSection } from '../UpdatesSection';
import { SettingsHeroCard } from '../SettingsHeroCard';
import { OfficeThemePicker } from '../OfficeThemePicker';
import { setArabicTerminalEnabled } from '@/terminal/arabicSetting';
import { notifyArabicTerminalChangeAll } from '@/components/terminalPool';
import { LANGUAGES, setLanguage } from '@/i18n';
import { slackInputStyle, sectionHead } from './shared';
import type { SettingsState } from './useSettingsState';

export function GeneralSection({ s }: { s: SettingsState }) {
  const { config, t, i18n, notifications, toggleNotifications, keepAwake, toggleKeepAwake, simpleMode, arabicTerminal, setArabicTerminal, arabicFollowsLanguage, setArabicFollowsLanguage, toggleSimpleMode, autoCompactOn, toggleAutoCompact, autoUpdateOn, toggleAutoUpdate, telemetryOn, toggleTelemetry, pickNewHome } = s;
  return (
                    <>
                      {/* Who you are and what this install is — version, plan,
                          sponsor, and the app-level actions that belong to none
                          of the settings below. Slots for a future subscription
                          and a sponsor live here; both render nothing until set. */}
                      <SettingsHeroCard />

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Updates — first among the settings proper, because "am I
                          on the latest?" is the question people open Settings to
                          answer, and the toolbar chip says nothing at all when
                          the answer is yes. */}
                      <UpdatesSection />

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Home folder */}
                      <div>
                        <div style={sectionHead}>
                          {t('settings.general.homeFolder')}
                        </div>
                        <div style={{ display: 'flex', gap: 12, fontSize: 13, lineHeight: '20px', alignItems: 'center' }}>
                          <span style={{
                            flex: 1, color: 'var(--cth-ink-900)', wordBreak: 'break-all',
                            fontFamily: 'var(--cth-font-mono, monospace)'
                          }}>{config.harnessHome ?? '—'}</span>
                          <PixelButton variant="secondary" size="sm" onClick={pickNewHome}>{t('settings.change')}</PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Environment — settings that used to be trapped in onboarding */}
                      <div>
                        <div style={sectionHead}>
                          {t('settings.general.environment')}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>{t('settings.general.keepAwake')}</span>
                              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                                {t('settings.general.keepAwakeDesc')}
                              </span>
                            </div>
                            <PixelButton variant={keepAwake ? 'primary' : 'secondary'} size="sm" onClick={toggleKeepAwake}>
                              {keepAwake ? t('common.on') : t('common.off')}
                            </PixelButton>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>{t('settings.general.simpleMode')}</span>
                              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                                {t('settings.general.simpleModeDesc')}
                              </span>
                            </div>
                            <PixelButton variant={simpleMode ? 'primary' : 'secondary'} size="sm" onClick={toggleSimpleMode}>
                              {simpleMode ? t('common.on') : t('common.off')}
                            </PixelButton>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                                {t('settings.general.arabicTerminal')}
                              </span>
                              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                                {t('settings.general.arabicTerminalDesc')}
                              </span>
                              {arabicFollowsLanguage && (
                                <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                                  {t('settings.general.arabicTerminalFollowsLanguage')}
                                </span>
                              )}
                            </div>
                            <PixelButton
                              variant={arabicTerminal ? 'primary' : 'secondary'}
                              size="sm"
                              onClick={() => {
                                const next = !arabicTerminal;
                                setArabicTerminalEnabled(next);
                                setArabicTerminal(next);
                                setArabicFollowsLanguage(false);
                                // Reach the terminals that are already open, the
                                // same way a language switch does.
                                notifyArabicTerminalChangeAll();
                              }}
                            >
                              {arabicTerminal ? t('common.on') : t('common.off')}
                            </PixelButton>
                          </div>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Language — app UI language (i18n) */}
                      <div>
                        <div style={sectionHead}>
                          {t('settings.general.language')}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>{t('settings.general.language')}</span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {t('settings.general.languageDesc')}
                            </span>
                          </div>
                          <select
                            value={i18n.language}
                            onChange={(e) => setLanguage(e.target.value)}
                            style={slackInputStyle}
                            aria-label={t('settings.general.language')}
                          >
                            {LANGUAGES.map((l) => (
                              <option key={l.code} value={l.code}>{l.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Desktop notifications toggle */}
                      <div>
                        <div style={sectionHead}>
                          {t('settings.general.notifications')}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              {t('settings.general.desktopNotifications')}
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {t('settings.general.desktopNotificationsDesc')}
                            </span>
                          </div>
                          <PixelButton
                            variant={notifications ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleNotifications}
                          >
                            {notifications ? t('common.on') : t('common.off')}
                          </PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Scheduled auto-compact (compact-maintenance mission) */}
                      <div>
                        <div style={sectionHead}>
                          {t('settings.general.maintenance')}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              {t('settings.general.autoCompact')}
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {t('settings.general.autoCompactDesc')}
                            </span>
                          </div>
                          <PixelButton
                            variant={autoCompactOn ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleAutoCompact}
                          >
                            {autoCompactOn ? t('common.on') : t('common.off')}
                          </PixelButton>
                        </div>
                        <div style={{ height: 10 }} />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              {t('settings.general.autoUpdate')}
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {t('settings.general.autoUpdateDesc')}
                            </span>
                          </div>
                          <PixelButton
                            variant={autoUpdateOn ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleAutoUpdate}
                          >
                            {autoUpdateOn ? t('common.on') : t('common.off')}
                          </PixelButton>
                        </div>
                        <div style={{ height: 10 }} />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              {t('settings.general.telemetry')}
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {t('settings.general.telemetryDesc')}
                            </span>
                          </div>
                          <PixelButton
                            variant={telemetryOn ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleTelemetry}
                          >
                            {telemetryOn ? t('common.on') : t('common.off')}
                          </PixelButton>
                        </div>
                      </div>

                      {/* Office Theme — TV-show office maps (experimental; flag tvShowOffices, default off) */}
                      <OfficeThemePicker config={config} />
                    </>
                  );
}
