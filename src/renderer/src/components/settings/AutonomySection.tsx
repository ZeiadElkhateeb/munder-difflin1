/**
 * Settings → Autonomy & Budgets: auto mode, spawn gate, max turns, cost caps, circuit breaker.
 */
import { PixelButton } from '../PixelButton';
import { slackInputStyle, slackLabelStyle, sectionHead } from './shared';
import type { SettingsState } from './useSettingsState';

export function AutonomySection({ s }: { s: SettingsState }) {
  const { t, godName, autoModeOn, toggleAutoMode, orchSpawnOn, toggleOrchSpawn, agentBudget, setAgentBudget, velocityCeiling, setVelocityCeiling, brkEnabled, setBrkEnabled, brkHardStop, setBrkHardStop, brkRepeated, setBrkRepeated, brkErrStorm, setBrkErrStorm, fmtBudgetTokens } = s;
  return (
                    <>
                      <div>
                        <div style={sectionHead}>
                          {t('settings.autonomy.autonomy')}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              {autoModeOn ? t('settings.autonomy.autoOn') : t('settings.autonomy.autoOff')}
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {t('settings.autonomy.autoDesc')}
                            </span>
                          </div>
                          <PixelButton variant={autoModeOn ? 'primary' : 'secondary'} size="sm" onClick={toggleAutoMode}>
                            {autoModeOn ? t('settings.autonomy.autonomous') : t('settings.autonomy.askFirst')}
                          </PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)', margin: '12px 0' }} />

                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              Who can add agents
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {orchSpawnOn
                                ? `${godName} can hire on his own. Every agent he starts spends tokens you did not approve.`
                                : `Only you. ${godName} can still ask, and his request waits in the queue instead of failing.`}
                            </span>
                          </div>
                          <PixelButton variant={orchSpawnOn ? 'primary' : 'secondary'} size="sm" onClick={toggleOrchSpawn}>
                            {orchSpawnOn ? `me and ${godName}` : 'only me'}
                          </PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Circuit breaker — the FULL unit (v0.3.4: all fields have UI) */}
                      <div>
                        <div style={sectionHead}>
                          {t('settings.autonomy.breaker')}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {t('settings.autonomy.breakerDesc')}
                            </span>
                            <PixelButton variant={brkEnabled ? 'primary' : 'secondary'} size="sm"
                              onClick={() => { setBrkEnabled(!brkEnabled); }}>
                              {brkEnabled ? t('common.on') : t('common.off')}
                            </PixelButton>
                          </div>
                          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                              {t('settings.autonomy.floorBudget')}
                              <input
                                type="number" min="0" step="100000" value={agentBudget}
                                onChange={(e) => setAgentBudget(e.target.value)}
                                placeholder={t('settings.autonomy.budgetPlaceholder')}
                                style={{ ...slackInputStyle, width: 180 }}
                              />
                              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                                {fmtBudgetTokens(agentBudget) ? t('settings.autonomy.budgetEquals', { value: fmtBudgetTokens(agentBudget) }) : t('settings.autonomy.budgetTotal')}
                              </span>
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                              {t('settings.autonomy.velocity')}
                              <input
                                type="number" min="0" step="1000" value={velocityCeiling}
                                onChange={(e) => setVelocityCeiling(e.target.value)}
                                placeholder={t('settings.autonomy.velocityPlaceholder')}
                                style={{ ...slackInputStyle, width: 180 }}
                              />
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                              {t('settings.autonomy.repeatedLimit')}
                              <input
                                type="number" min="0" step="5" value={brkRepeated}
                                onChange={(e) => setBrkRepeated(e.target.value)}
                                placeholder={t('settings.autonomy.defaultPlaceholder')}
                                style={{ ...slackInputStyle, width: 140 }}
                              />
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                              {t('settings.autonomy.errorStormLimit')}
                              <input
                                type="number" min="0" step="5" value={brkErrStorm}
                                onChange={(e) => setBrkErrStorm(e.target.value)}
                                placeholder={t('settings.autonomy.defaultPlaceholder')}
                                style={{ ...slackInputStyle, width: 140 }}
                              />
                            </label>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>{t('settings.autonomy.hardStop')}</span>
                              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                                {t('settings.autonomy.hardStopDesc')}
                              </span>
                            </div>
                            <PixelButton variant={brkHardStop ? 'destructive' : 'secondary'} size="sm"
                              onClick={() => { setBrkHardStop(!brkHardStop); }}>
                              {brkHardStop ? t('settings.autonomy.killOnTrip') : t('settings.autonomy.steerFirst')}
                            </PixelButton>
                          </div>
                        </div>
                      </div>
                    </>
                  );
}
