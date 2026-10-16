/**
 * Settings → Agents & Models: default engine, orchestrator model, AI engines and keys.
 */
import { agentModels } from '@/store/config';
import { AiEnginesSettings } from '../AiEnginesSettings';
import { slackInputStyle, sectionHead } from './shared';
import type { SettingsState } from './useSettingsState';

export function AgentsModelsSection({ s }: { s: SettingsState }) {
  const { config, t, godName, defaultModelSel, saveDefaultModel, maxTurnsVal, setMaxTurnsVal } = s;
  return (
                    <>
                      <div>
                        <div style={sectionHead}>
                          {t('settings.agentsModels.defaultModel')}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                            {t('settings.agentsModels.defaultModelDesc', { godName })}
                          </span>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {agentModels().map((m) => (
                              <button
                                key={m.label}
                                onClick={() => { if (m.id) void saveDefaultModel(m.id); }}
                                style={{
                                  padding: '3px 8px 1px', border: 'none', cursor: 'pointer',
                                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                                  background: defaultModelSel === m.id ? 'var(--cth-sky-light)' : 'var(--cth-cream-100)',
                                  boxShadow: defaultModelSel === m.id ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)'
                                }}
                              >{m.label}</button>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      <AiEnginesSettings config={config} />

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Advanced */}
                      <div>
                        <div style={sectionHead}>
                          {t('settings.agentsModels.advanced')}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 13, color: 'var(--cth-ink-900)' }}>{t('settings.agentsModels.maxTurns')}</span>
                          <input
                            type="number" min="1" step="10" value={maxTurnsVal}
                            onChange={(e) => setMaxTurnsVal(e.target.value)}
                            placeholder={t('settings.agentsModels.unlimited')}
                            style={{ ...slackInputStyle, width: 120 }}
                          />
                          <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('settings.agentsModels.blankUnlimited')}</span>
                        </div>
                      </div>
                    </>
                  );
}
