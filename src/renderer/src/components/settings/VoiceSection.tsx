/**
 * Settings → Voice: Realtime Michael, dictation (Free Flow) and transcription.
 */
import type { HarnessConfig } from '@/store/config';
import { PixelButton } from '../PixelButton';
import { REALTIME_MODEL } from '@shared/realtimePricing';
import { RealtimeDevicePicker } from '@/realtime/DevicePicker';
import { CostHud } from '@/realtime/CostHud';
import { isComposingKey } from '@shared/imeGuard';
import { slackInputStyle, slackLabelStyle, sectionHeadTight, sectionHeadFlush, sectionRule } from './shared';
import type { SettingsState } from './useSettingsState';

export function VoiceSection({ s }: { s: SettingsState }) {
  const { t, godName, stage, hasOpenAiKey, openAiVoiceKey, setOpenAiVoiceKey, openAiVoiceNote, saveOpenAiVoiceKey, freeflowEnabled, groqKey, setGroqKey, freeflowModel, setFreeflowModel, showGroqKey, setShowGroqKey, freeflowBusy, freeflowNote, idleDisconnectMs, setIdleDisconnectMs, saveFreeflow, toggleFreeflow } = s;
  return (
                    <>
                      {/* Free Flow (voice dictation) */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={sectionHeadTight}>
                          {t('settings.voice.freeFlow')}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              {t('settings.voice.freeFlowTitle')}
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {t('settings.voice.freeFlowDesc')}
                            </span>
                          </div>
                          <PixelButton
                            variant={freeflowEnabled ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleFreeflow}
                            disabled={freeflowBusy}
                          >
                            {freeflowEnabled ? t('common.on') : t('common.off')}
                          </PixelButton>
                        </div>

                        {freeflowEnabled && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {/* Groq API key — stored in main config, used only there. */}
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <span style={slackLabelStyle}>{t('settings.voice.groqKey')}</span>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <input
                                  type={showGroqKey ? 'text' : 'password'}
                                  value={groqKey}
                                  onChange={(e) => setGroqKey(e.target.value)}
                                  placeholder={t('settings.voice.groqPlaceholder')}
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                                <PixelButton variant="secondary" size="sm" onClick={() => setShowGroqKey((v) => !v)} disabled={!groqKey}>
                                  {showGroqKey ? t('common.hide') : t('common.show')}
                                </PixelButton>
                              </div>
                            </label>

                            {/* Model picker */}
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 280 }}>
                              <span style={slackLabelStyle}>{t('settings.voice.model')}</span>
                              <select
                                value={freeflowModel}
                                onChange={(e) => setFreeflowModel(e.target.value)}
                                style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                              >
                                <option value="whisper-large-v3-turbo">{t('settings.voice.fast')}</option>
                                <option value="whisper-large-v3">{t('settings.voice.accurate')}</option>
                              </select>
                            </label>

                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <PixelButton variant="ghost" size="sm" onClick={() => saveFreeflow()} disabled={freeflowBusy}>
                                {t('common.save')}
                              </PixelButton>
                              {freeflowNote && (
                                <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{freeflowNote}</span>
                              )}
                            </div>

                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              {t('settings.voice.freeFlowHint')}
                            </span>
                          </div>
                        )}
                      </div>

                      <div style={sectionRule} />

                      {/* Realtime Michael — voice device selection (rt-8) */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={sectionHeadTight}>
                          {t('settings.voice.realtime')}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                            {t('settings.voice.voiceChat', { godName })}
                          </span>
                          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                            {t('settings.voice.voiceChatDesc', { godName })}
                          </span>
                        </div>

                        {/* OpenAI Realtime key — settable HERE, not just described here.
                            This is where someone looking for voice actually lands (the Talk
                            button deep-links to it), so sending them to another tab to type
                            the key was a dead end dressed up as documentation. Same broker
                            slot as Agents & Models (apikey:openai) — one key, two doorways,
                            and saving in either flips the same gate. The value never leaves
                            main; only the presence boolean comes back. */}
                        <div style={{
                          display: 'flex', flexDirection: 'column', gap: 8,
                          padding: 10,
                          background: 'var(--cth-paper-100)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                        }}>
                          <span style={sectionHeadFlush}>
                            {t('settings.voice.openaiKey')}
                          </span>
                          <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
                            {t('settings.voice.openaiKeyDesc1', { godName, model: REALTIME_MODEL })}
                          </span>
                          <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
                            {t('settings.voice.openaiKeyDesc2')}
                          </span>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                              type="password"
                              value={openAiVoiceKey}
                              onChange={(e) => setOpenAiVoiceKey(e.target.value)}
                              onKeyDown={(e) => { if (isComposingKey(e)) return; if (e.key === 'Enter') void saveOpenAiVoiceKey(); }}
                              placeholder={hasOpenAiKey ? t('settings.voice.keyPlaceholderSaved') : 'sk-…'}
                              style={{ ...slackInputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)' }}
                            />
                            <PixelButton
                              variant="secondary"
                              size="sm"
                              onClick={() => void saveOpenAiVoiceKey()}
                              disabled={!openAiVoiceKey.trim()}
                            >
                              {t('settings.voice.save')}
                            </PixelButton>
                          </div>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                            fontSize: 12, lineHeight: '16px',
                            color: hasOpenAiKey ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)'
                          }}>
                            <span aria-hidden style={{
                              width: 8, height: 8, flexShrink: 0,
                              background: hasOpenAiKey ? 'var(--cth-mint)' : 'var(--cth-ink-300)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                            }} />
                            {openAiVoiceNote || (hasOpenAiKey
                              ? t('settings.voice.keySaved', { godName })
                              : t('settings.voice.noKey', { godName }))}
                          </span>
                        </div>

                        <RealtimeDevicePicker />
                        <CostHud />
                        {/* rt-9 idle-tunable: how long an idle voice session stays open before
                            it auto-closes. The spend cap remains the real runaway guard. */}
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 280 }}>
                          <span style={slackLabelStyle}>{t('settings.voice.idleDisconnect')}</span>
                          <select
                            value={String(idleDisconnectMs)}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              setIdleDisconnectMs(v);
                              stage({ realtimeIdleDisconnectMs: v } as Partial<HarnessConfig>);
                            }}
                            style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                          >
                            <option value="30000">{t('settings.voice.30s')}</option>
                            <option value="60000">{t('settings.voice.1m')}</option>
                            <option value="120000">{t('settings.voice.2m')}</option>
                            <option value="180000">{t('settings.voice.3m')}</option>
                            <option value="300000">{t('settings.voice.5m')}</option>
                            <option value="600000">{t('settings.voice.10m')}</option>
                            <option value="0">{t('settings.voice.never')}</option>
                          </select>
                          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                            {t('settings.voice.idleDisconnectDesc')}
                          </span>
                        </label>
                      </div>
                    </>
                  );
}
