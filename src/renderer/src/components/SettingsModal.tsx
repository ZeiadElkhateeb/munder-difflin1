import type { HarnessConfig } from '@/store/config';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { SetupPanel } from './SetupPanel';
import { Icon } from './Icon';
import { McpDefaultsSettings } from './McpDefaultsSettings';
import { type Section, NAV_SECTIONS, NAV_SECTION_KEYS } from './settings/shared';
import { useSettingsState } from './settings/useSettingsState';
import { GeneralSection } from './settings/GeneralSection';
import { AgentsModelsSection } from './settings/AgentsModelsSection';
import { AutonomySection } from './settings/AutonomySection';
import { MemorySection } from './settings/MemorySection';
import { ConnectionsSection } from './settings/ConnectionsSection';
import { VoiceSection } from './settings/VoiceSection';
// App.tsx imports the section type from here.
export type { Section } from './settings/shared';

export interface SettingsModalProps {
  config: HarnessConfig;
  onClose: () => void;
  /** Open straight to a section instead of General. Used by deep links from
   *  elsewhere in the UI — "set it now" beside a disabled Talk button lands on
   *  the tab that actually holds the field, rather than making the user hunt. */
  initialSection?: Section;
}

export function SettingsModal({ config, onClose, initialSection }: SettingsModalProps) {
  const s = useSettingsState({ config, onClose, initialSection });
  const { t, godName, confirming, setConfirming, busy, activeSection, setActiveSection, changeHome, setChangeHome, changeMode, setChangeMode, changeBusy, changeErr, setChangeErr, saveBusy, saveNote, dirty, saveAll, requestClose, reset, applyChangeHome, modalTitle } = s;
  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 300
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 840, maxWidth: '92vw', maxHeight: '88vh',
          display: 'flex', flexDirection: 'column',
          filter: 'drop-shadow(4px 4px 0 rgba(26, 19, 32, 0.25))'
        }}
      >
        <PixelPanel
          variant="dialog"
          title={modalTitle}
          noPadding
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', maxHeight: '88vh' }}
        >
          {/* === Change home sub-modal === */}
          {changeHome ? (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('settings.changeHome.newHome')}</span>
                <code style={{
                  fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 12,
                  color: 'var(--cth-ink-900)', wordBreak: 'break-all'
                }}>{changeHome}</code>
              </div>

              {/* Move vs. fresh - two selectable option rows; move is preselected. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {([
                  ['move', t('settings.changeHome.moveTitle'), t('settings.changeHome.moveDesc')],
                  ['fresh', t('settings.changeHome.freshTitle'), t('settings.changeHome.freshDesc')]
                ] as const).map(([value, title, desc]) => {
                  const selected = changeMode === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setChangeMode(value)}
                      disabled={changeBusy}
                      style={{
                        textAlign: 'left', cursor: changeBusy ? 'default' : 'pointer',
                        padding: '10px 12px', background: 'var(--cth-paper-100)', border: 'none',
                        boxShadow: `inset 0 0 0 ${selected ? 2 : 1}px ${selected ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
                        display: 'flex', flexDirection: 'column', gap: 3
                      }}
                    >
                      <span style={{
                        fontSize: 13, lineHeight: '20px',
                        color: 'var(--cth-ink-900)', fontWeight: selected ? 700 : 400
                      }}>
                        {selected ? '◉ ' : '○ '}{title}
                      </span>
                      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{desc}</span>
                    </button>
                  );
                })}
              </div>

              {changeErr && (
                <div style={{ fontSize: 12, lineHeight: '18px', color: '#6E1423' }}>{changeErr}</div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <PixelButton variant="secondary" size="md" onClick={() => { setChangeHome(null); setChangeErr(''); }} disabled={changeBusy}>
                  {t('common.cancel')}
                </PixelButton>
                <PixelButton variant="primary" size="md" onClick={applyChangeHome} disabled={changeBusy}>
                  {changeBusy ? t('settings.apply') : (changeMode === 'move' ? t('settings.moveAndRestart') : t('settings.switchAndRestart'))}
                </PixelButton>
              </div>
            </div>

          /* === Reset confirmation screen === */
          ) : confirming ? (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{
                  width: 32, height: 32,
                  background: 'var(--cth-coral-light)',
                  boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0
                }}>
                  <Icon name="bell" />
                </div>
                <div style={{ flex: 1, fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
                  {t('settings.resetConfirm.body', { godName })}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <PixelButton variant="secondary" size="md" onClick={() => setConfirming(false)} disabled={busy}>
                  {t('common.cancel')}
                </PixelButton>
                <PixelButton variant="destructive" size="md" onClick={reset} disabled={busy}>
                  {busy ? t('settings.resetting') : t('settings.eraseEverything')}
                </PixelButton>
              </div>
            </div>

          /* === Main two-pane settings layout === */
          ) : (
            <>
              <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

                {/* Left nav */}
                <div style={{
                  width: 160, flexShrink: 0,
                  display: 'flex', flexDirection: 'column',
                  borderRight: '2px solid var(--cth-ink-300)',
                  paddingTop: 8, paddingBottom: 8,
                  background: 'var(--cth-cream-200)'
                }}>
                  {NAV_SECTIONS.map((section) => {
                    const active = activeSection === section;
                    return (
                      <button
                        key={section}
                        type="button"
                        onClick={() => setActiveSection(section)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '10px 16px 8px',
                          border: 'none',
                          borderLeft: active ? '3px solid var(--cth-lemon)' : '3px solid transparent',
                          background: active ? 'var(--cth-ink-900)' : 'transparent',
                          color: active ? 'var(--cth-cream-50)' : 'var(--cth-ink-700)',
                          fontFamily: 'var(--cth-font-display)',
                          fontSize: 8,
                          lineHeight: '12px',
                          cursor: 'pointer',
                          letterSpacing: 0
                        }}
                      >
                        {t(NAV_SECTION_KEYS[section])}
                      </button>
                    );
                  })}
                </div>

                {/* Right scrollable content pane. minWidth:0 lets this flex child
                    shrink to the row's width instead of growing to its content's
                    min-content (which would push a horizontal scrollbar). */}
                <div style={{
                  flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden',
                  padding: '20px 24px',
                  display: 'flex', flexDirection: 'column', gap: 20
                }}>

                  {/* GENERAL */}
                  {activeSection === 'General' && <GeneralSection s={s} />}

                  {/* AGENTS & MODELS — what powers the office */}
                  {/* PREREQUISITES — the external tools the app leans on and
                      whether this machine has them. It was a Command Center tab,
                      which was the wrong home: it is machine-wide state, not
                      something about the agent whose terminal you are reading. */}
                  {activeSection === 'Prerequisites' && <SetupPanel onDone={onClose} />}

                  {activeSection === 'Agents & Models' && <AgentsModelsSection s={s} />}

                  {/* AUTONOMY & BUDGETS — the safety tab */}
                  {activeSection === 'Autonomy & Budgets' && <AutonomySection s={s} />}

                  {/* MEMORY & KNOWLEDGE */}
                  {activeSection === 'Memory & Knowledge' && <MemorySection s={s} />}

                  {/* CONNECTIONS — everything external (MCP + Slack + webhook + REST) */}
                  {activeSection === 'Connections' && (
                    <>
                      <McpDefaultsSettings config={config} />
                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />
                    </>
                  )}

                  {activeSection === 'Connections' && <ConnectionsSection s={s} />}

                  {/* VOICE — Free Flow dictation + Realtime Michael (v0.3.4: its own tab) */}
                  {activeSection === 'Voice' && <VoiceSection s={s} />}

                  {/* Danger — a red row at the bottom of General (was its own tab) */}
                  {activeSection === 'General' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <div style={{
                        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                        color: '#6E1423'
                      }}>{t('settings.general.dangerZone')}</div>
                      <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
                        {t('settings.general.dangerDesc', { godName })}
                      </p>
                      <div>
                        <PixelButton variant="destructive" size="md" onClick={() => setConfirming(true)}>
                          {t('settings.general.resetStartOver')}
                        </PixelButton>
                      </div>
                    </div>
                  )}

                </div>
              </div>

              {/* Footer */}
              <div style={{
                borderTop: '2px solid var(--cth-ink-300)',
                padding: '10px 16px',
                display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8,
                background: 'var(--cth-cream-50)'
              }}>
                {saveNote && (
                  <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{saveNote}</span>
                )}
                {dirty && !saveNote && (
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('settings.unsavedChanges')}</span>
                )}
                <PixelButton variant="secondary" size="md" onClick={requestClose}>{t('settings.close')}</PixelButton>
                <PixelButton variant="primary" size="md" onClick={() => void saveAll()} disabled={saveBusy}>
                  {saveBusy ? t('settings.saving') : t('common.save')}
                </PixelButton>
              </div>
            </>
          )}
        </PixelPanel>
      </div>
    </div>
  );
}
