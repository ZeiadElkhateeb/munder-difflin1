/**
 * Settings → Memory & Knowledge: semantic memory, reflection, knowledge graph.
 */
import { PixelButton } from '../PixelButton';
import { sectionHead } from './shared';
import type { SettingsState } from './useSettingsState';

export function MemorySection({ s }: { s: SettingsState }) {
  const { t, semMemOn, toggleSemMem, kgEnabled, kgDocCount, kgBusy, kgNote, toggleKg, addKgFiles } = s;
  return (
                    <>
                      <div>
                        <div style={sectionHead}>
                          {t('settings.memory.semanticMemory')}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>{t('settings.memory.crossSession')}</span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {t('settings.memory.crossSessionDesc')}
                            </span>
                          </div>
                          <PixelButton variant={semMemOn ? 'primary' : 'secondary'} size="sm" onClick={toggleSemMem}>
                            {semMemOn ? t('common.on') : t('common.off')}
                          </PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Knowledge Graph — enterprise multimodal context for agents */}
                      <div>
                        <div style={sectionHead}>
                          {t('settings.memory.kg')}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              {t('settings.memory.kgTitle')}
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {t('settings.memory.kgDesc')}
                            </span>
                          </div>
                          <PixelButton
                            variant={kgEnabled ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleKg}
                          >
                            {kgEnabled ? t('common.on') : t('common.off')}
                          </PixelButton>
                        </div>
                        {kgEnabled && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                            <PixelButton variant="secondary" size="sm" onClick={addKgFiles} disabled={kgBusy}>
                              {kgBusy ? t('settings.memory.adding') : t('settings.memory.addFiles')}
                            </PixelButton>
                            <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                              {kgDocCount === 1
                                ? t('settings.memory.docCount', { count: kgDocCount })
                                : t('settings.memory.docCountPlural', { count: kgDocCount })}
                            </span>
                            {kgNote && <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{kgNote}</span>}
                          </div>
                        )}
                      </div>
                    </>
                  );
}
