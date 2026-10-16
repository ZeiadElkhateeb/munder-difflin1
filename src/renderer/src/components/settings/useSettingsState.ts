/**
 * State and handlers behind the Settings modal: staged config changes, the single
 * saveAll writer, close guard, and per-section data loading.
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { useStore } from '@/store/store';
import { DEFAULT_TRIGGER_MODE, DEFAULT_WEBHOOK_SCHEMA, type OrgTriggerConfig, type WebhookTrigger } from '@shared/triggers';
import { isArabicTerminalEnabled, isArabicTerminalFollowingLanguage } from '@/terminal/arabicSetting';
import { triggersApi, newWebhookId, clearLocalState, type Section } from './shared';
import type { SettingsModalProps } from '../SettingsModal';

  // --- circuit-breaker config (Lane A #6 canonical fields, widened view) ---
  // Drives Jim's real breaker: floor-wide TOKEN budget (costCapTokens) + output-
  // token velocity ceiling (circuitBreaker.tokenVelocityPerMin). The token cap
  // replaced the old dollar cap as the user-facing budget.
  export type BreakerCfgView = HarnessConfig & {
    costCapTokens?: number;
    circuitBreaker?: { tokenVelocityPerMin?: number; enabled?: boolean; hardStop?: boolean; repeatedToolLimit?: number; errorStormLimit?: number };
  };

/** Every piece of state, staged change and handler the Settings modal and its sections use. */
export function useSettingsState({ config, onClose, initialSection }: SettingsModalProps) {
  const { t, i18n } = useTranslation();
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name) ?? 'the orchestrator';
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeSection, setActiveSection] = useState<Section>(initialSection ?? 'General');
  // Change-home flow: null until the user picks a new folder, then the sub-modal
  // confirms move-vs-fresh. Pre-selects 'move' (recommended - keeps the data).
  const [changeHome, setChangeHome] = useState<string | null>(null);
  const [changeMode, setChangeMode] = useState<'move' | 'fresh'>('move');
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeErr, setChangeErr] = useState('');
  // `notifications` is an optional field on the main-process config; the renderer
  // mirror type may not declare it yet, so read it defensively.
  const [notifications, setNotifications] = useState<boolean>(
    (config as HarnessConfig & { notifications?: boolean }).notifications === true
  );
  const toggleNotifications = async () => {
    const next = !notifications;
    setNotifications(next); // optimistic
    try { await window.cth.setNotifications(next); }
    catch { setNotifications(!next); /* revert on failure */ }
  };
  // ─── v0.3.4 redesign: settings that were onboarding-trapped or UI-less ────
  const cfgX = config as HarnessConfig & {
    strongKeepalive?: boolean; audience?: string; autoMode?: boolean;
    defaultModel?: string; maxTurns?: number; semanticMemory?: boolean;
  };
  /**
   * ONE SAVE BUTTON.
   *
   * Settings used to persist three different ways: toggles wrote to disk the
   * instant you clicked them, some sections had their own Save, and a couple of
   * fields saved on blur. Nothing told you which kind you were looking at, so
   * "did that stick?" had no answer you could learn once and reuse.
   *
   * Now every setting that goes through `updateConfig` is STAGED here and
   * written by the footer Save, in a single call.
   *
   * Two things stay immediate, on purpose, and they are not settings:
   *   - API keys, which go to the write-only secret broker. Nothing can read
   *     one back to diff it, so there is no staged value to hold.
   *   - Free Flow, which arms a global hotkey in main. Staging that would leave
   *     the hotkey and the checkbox disagreeing until you pressed Save.
   * Slack and webhooks keep their own controls too: those connect and
   * disconnect live rather than storing a preference.
   */
  const [pending, setPending] = useState<Partial<HarnessConfig>>({});
  /** Auto-compact lives inside the missions array, so it is resolved at save
   *  time against the config on disk rather than staged as a whole array. */
  const [autoCompactPending, setAutoCompactPending] = useState<boolean | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveNote, setSaveNote] = useState('');
  /** True once a control that USED to persist on click has been changed. Only
   *  those need the close guard: the text fields always needed a Save. */
  const dirty = Object.keys(pending).length > 0 || autoCompactPending !== null;
  const stage = (patch: Partial<HarnessConfig>): void =>
    setPending((prev) => ({ ...prev, ...patch }));
  const [keepAwake, setKeepAwake] = useState<boolean>(cfgX.strongKeepalive === true);
  const toggleKeepAwake = async () => {
    const next = !keepAwake;
    setKeepAwake(next);
    stage({ strongKeepalive: next } as Partial<HarnessConfig>);
  };
  const [simpleMode, setSimpleMode] = useState<boolean>(cfgX.audience === 'non-technical');
  // Renderer-local, not part of HarnessConfig — it only changes how this window
  // paints pty output. Read once; the setter keeps localStorage in step.
  const [arabicTerminal, setArabicTerminal] = useState(isArabicTerminalEnabled);
  // Whether that value is the language's default or a choice the user made.
  // Shown as a note rather than a second control: the toggle already IS the
  // override, so the only thing missing is telling them which one they are
  // looking at. Re-read on every language change, because the default moves.
  const [arabicFollowsLanguage, setArabicFollowsLanguage] = useState(isArabicTerminalFollowingLanguage);
  useEffect(() => {
    setArabicTerminal(isArabicTerminalEnabled());
    setArabicFollowsLanguage(isArabicTerminalFollowingLanguage());
  }, [i18n.language]);
  const toggleSimpleMode = async () => {
    const next = !simpleMode;
    setSimpleMode(next);
    stage({ audience: next ? 'non-technical' : 'technical' } as Partial<HarnessConfig>);
  };
  const [autoModeOn, setAutoModeOn] = useState<boolean>(cfgX.autoMode !== false);
  const toggleAutoMode = async () => {
    const next = !autoModeOn;
    setAutoModeOn(next);
    stage({ autoMode: next } as Partial<HarnessConfig>);
  };
  // Default OFF, so an absent value must read as off. Note this is `=== true`,
  // the mirror image of autoMode's `!== false` above, because the two defaults
  // are opposite.
  const [orchSpawnOn, setOrchSpawnOn] = useState<boolean>(cfgX.orchestratorMaySpawn === true);
  const toggleOrchSpawn = async () => {
    const next = !orchSpawnOn;
    setOrchSpawnOn(next);
    stage({ orchestratorMaySpawn: next } as Partial<HarnessConfig>);
  };
  const [defaultModelSel, setDefaultModelSel] = useState<string>(cfgX.defaultModel ?? 'claude-fable-5');
  const saveDefaultModel = (id: string): void => {
    setDefaultModelSel(id);
    stage({ defaultModel: id } as Partial<HarnessConfig>);
  };
  const [maxTurnsVal, setMaxTurnsVal] = useState<string>(cfgX.maxTurns != null ? String(cfgX.maxTurns) : '');
  const maxTurnsPatch = (): Partial<HarnessConfig> => {
    const n = maxTurnsVal.trim() === '' ? undefined : Number(maxTurnsVal);
    return { maxTurns: Number.isFinite(n as number) && (n as number) > 0 ? Math.round(n as number) : undefined } as Partial<HarnessConfig>;
  };
  const [semMemOn, setSemMemOn] = useState<boolean>(cfgX.semanticMemory !== false);
  const toggleSemMem = async () => {
    const next = !semMemOn;
    setSemMemOn(next);
    stage({ semanticMemory: next } as Partial<HarnessConfig>);
  };
  const breakerCfg = config as BreakerCfgView;
  const [agentBudget, setAgentBudget] = useState(breakerCfg.costCapTokens != null ? String(breakerCfg.costCapTokens) : '');
  const [velocityCeiling, setVelocityCeiling] = useState(breakerCfg.circuitBreaker?.tokenVelocityPerMin != null ? String(breakerCfg.circuitBreaker.tokenVelocityPerMin) : '');
  // v0.3.4: the four previously UI-less breaker fields get controls.
  const [brkEnabled, setBrkEnabled] = useState<boolean>(breakerCfg.circuitBreaker?.enabled !== false);
  const [brkHardStop, setBrkHardStop] = useState<boolean>(breakerCfg.circuitBreaker?.hardStop === true);
  const [brkRepeated, setBrkRepeated] = useState(breakerCfg.circuitBreaker?.repeatedToolLimit != null ? String(breakerCfg.circuitBreaker.repeatedToolLimit) : '');
  const [brkErrStorm, setBrkErrStorm] = useState(breakerCfg.circuitBreaker?.errorStormLimit != null ? String(breakerCfg.circuitBreaker.errorStormLimit) : '');
  const budgetPatch = (): Partial<HarnessConfig> => {
    const tokens = agentBudget.trim() === '' ? undefined : Number(agentBudget);
    const vel = velocityCeiling.trim() === '' ? undefined : Number(velocityCeiling);
    const rep = brkRepeated.trim() === '' ? undefined : Number(brkRepeated);
    const storm = brkErrStorm.trim() === '' ? undefined : Number(brkErrStorm);
    return {
      costCapTokens: Number.isFinite(tokens as number) ? (tokens as number) : undefined,
      circuitBreaker: {
        ...(breakerCfg.circuitBreaker ?? {}),
        enabled: brkEnabled,
        hardStop: brkHardStop,
        tokenVelocityPerMin: Number.isFinite(vel as number) ? (vel as number) : undefined,
        repeatedToolLimit: Number.isFinite(rep as number) ? Math.round(rep as number) : undefined,
        errorStormLimit: Number.isFinite(storm as number) ? Math.round(storm as number) : undefined
      }
    } as Partial<HarnessConfig>;
  };
  /** The one writer. Commits what the form currently shows, in a single
   *  updateConfig, so a half-applied save is not a state the app can reach. */
  const saveAll = async (): Promise<void> => {
    setSaveBusy(true); setSaveNote('');
    try {
      const patch: Partial<HarnessConfig> = {
        ...maxTurnsPatch(),
        ...budgetPatch(),
        ...pending
      };
      if (autoCompactPending !== null) {
        // Read-modify-write against disk, not against a stale copy: another
        // window (or main) may have edited a different mission meanwhile.
        const cfg = await window.cth.getConfig();
        patch.missions = (cfg.missions ?? []).map((m) =>
          m.id === 'compact-maintenance' ? { ...m, enabled: autoCompactPending } : m
        );
      }
      await window.cth.updateConfig(patch);
      setPending({});
      setAutoCompactPending(null);
      setSaveNote(t('settings.saved'));
      setTimeout(() => setSaveNote(''), 1800);
    } catch (e) {
      setSaveNote(e instanceof Error ? e.message : String(e));
    } finally { setSaveBusy(false); }
  };
  /** Closing with staged changes used to be impossible, because everything wrote
   *  on click. Now it is, so say so rather than dropping the edit silently. */
  const requestClose = (): void => {
    if (dirty && !window.confirm(t('settings.unsavedWarning'))) return;
    onClose();
  };
  const fmtBudgetTokens = (raw: string): string => {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) return '';
    if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
    return String(n);
  };
  // --- Slack integration ---
  const [slackEnabled, setSlackEnabled] = useState(config.slackEnabled ?? false);
  const [slackSecret, setSlackSecret] = useState(config.slackSigningSecret ?? '');
  const [slackBotToken, setSlackBotToken] = useState(config.slackBotToken ?? '');
  const [slackChannel, setSlackChannel] = useState(config.slackChannelId ?? '');
  const [slackPort, setSlackPort] = useState(String(config.slackPort ?? 3847));
  // App/voice-initiated proactive posting (the "queued" ack). Default OFF —
  // the Slack-origin done-reply round-trip is unaffected by this toggle.
  const [slackProactivePosting, setSlackProactivePosting] = useState(config.slackProactivePosting ?? false);
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackNote, setSlackNote] = useState('');
  // Whether the webhook server is currently live. Hydrated from main on open so
  // reopening Settings shows the true connection state + the persisted Request URL.
  const [running, setRunning] = useState(false);
  // Whether the connect-steps help panel is expanded.
  const [showSlackHelp, setShowSlackHelp] = useState(false);
  // --- Webhook triggers (a LIST; src/shared/triggers.ts owns the type) ---------
  // The list itself lives in the store, not in local state: the Triggers tab
  // edits the same webhooks, and one of the two surfaces holding a private copy
  // is exactly the drift this feature exists to prevent.
  const webhookTriggers = useStore((s) => s.webhookTriggers);
  const setWebhookTriggersStore = useStore((s) => s.setWebhookTriggers);
  /** Public base URL of the shared tunnel; each webhook's endpoint is `<base>/<id>`. */
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookRunning, setWebhookRunning] = useState(false);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookNote, setWebhookNote] = useState('');
  /** Which secrets the user has unmasked, by webhook id. Reset on every reopen. */
  const [shownSecrets, setShownSecrets] = useState<Record<string, boolean>>({});
  /** Webhook awaiting a second delete click — deleting one revokes a live caller. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [showWebhookHelp, setShowWebhookHelp] = useState(false);
  // --- Organisation trigger (peer messaging; configuration only for now) ------
  const orgTrigger = useStore((s) => s.orgTrigger);
  const setOrgTriggerStore = useStore((s) => s.setOrgTrigger);
  const [showOrgKey, setShowOrgKey] = useState(false);
  const [orgBusy, setOrgBusy] = useState(false);
  const [orgNote, setOrgNote] = useState('');
  // ─── Knowledge Graph (enterprise multimodal context for agents) ───────────
  const [kgEnabled, setKgEnabled] = useState<boolean>(
    (config as HarnessConfig & { knowledgeGraph?: { enabled?: boolean } }).knowledgeGraph?.enabled === true
  );
  const [kgDocCount, setKgDocCount] = useState(0);
  const [kgBusy, setKgBusy] = useState(false);
  const [kgNote, setKgNote] = useState('');
  const refreshKgStatus = async () => {
    try { const s = await window.cth.kgStatus(); setKgDocCount(s.docCount); }
    catch { /* status unavailable */ }
  };
  const toggleKg = async () => {
    const next = !kgEnabled;
    setKgEnabled(next);
    try {
      stage({ knowledgeGraph: { enabled: next } });
      if (next) await refreshKgStatus();
    } catch { setKgEnabled(!next); }
  };
  const addKgFiles = async () => {
    setKgBusy(true); setKgNote('');
    try {
      const res = await window.cth.kgAddFiles();
      if (!res.ok) { setKgNote(res.error === 'cancelled' ? '' : (res.error ?? 'failed')); return; }
      const added = res.results.filter((r) => r.ok).length;
      const failed = res.results.length - added;
      setKgNote(`added ${added} document${added === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`);
      await refreshKgStatus();
    } catch (e) { setKgNote(e instanceof Error ? e.message : String(e)); }
    finally { setKgBusy(false); }
  };
  // ─── Scheduled auto-compact — the compact-maintenance mission's enabled flag.
  // The mission itself stays the single source of truth (the Triggers tab edits
  // the same field); this is just a General-section shortcut. Default OFF (v0.3.4).
  const [autoCompactOn, setAutoCompactOn] = useState<boolean>(
    (config.missions ?? []).some((m) => m.id === 'compact-maintenance' && m.enabled)
  );
  const toggleAutoCompact = async () => {
    const next = !autoCompactOn;
    setAutoCompactOn(next);
    setAutoCompactPending(next);
  };
  // ─── Auto-update (default ON; gates main's updater checks entirely) ────────
  const [autoUpdateOn, setAutoUpdateOn] = useState<boolean>(config.autoUpdate !== false);
  const toggleAutoUpdate = async () => {
    const next = !autoUpdateOn;
    setAutoUpdateOn(next);
    try { stage({ autoUpdate: next }); }
    catch { setAutoUpdateOn(!next); }
  };
  // ─── Anonymous usage stats (default ON = opt-out; contract in TELEMETRY.md) ─
  const [telemetryOn, setTelemetryOn] = useState<boolean>(config.telemetryEnabled !== false);
  const toggleTelemetry = async () => {
    const next = !telemetryOn;
    setTelemetryOn(next);
    try { stage({ telemetryEnabled: next }); }
    catch { setTelemetryOn(!next); }
  };
  // --- Free Flow (voice dictation → message queue) ---
  const setFreeflowEnabledStore = useStore((s) => s.setFreeflowEnabled);
  const setHasGroqKeyStore = useStore((s) => s.setHasGroqKey);
  // Talk (Realtime Michael) is gated on the OpenAI key — read the live presence
  // boolean so the Realtime Michael section can show its enabled/disabled status.
  const hasOpenAiKey = useStore((s) => s.hasOpenAiKey);
  // Voice-tab entry for the SAME broker slot Agents & Models writes (apikey:openai).
  // Mirroring presence into the store on save is what makes the Talk button light up
  // immediately instead of on next launch.
  const setHasOpenAiKey = useStore((s) => s.setHasOpenAiKey);
  const [openAiVoiceKey, setOpenAiVoiceKey] = useState('');
  const [openAiVoiceNote, setOpenAiVoiceNote] = useState('');
  const saveOpenAiVoiceKey = async (): Promise<void> => {
    const key = openAiVoiceKey.trim();
    if (!key) return;
    try {
      const r = await window.cth.providerKeySet({ backend: 'openai', key });
      if (r.ok) {
        setOpenAiVoiceKey('');
        setHasOpenAiKey(true);
        setOpenAiVoiceNote(t('settings.voice.keySavedNote'));
      } else setOpenAiVoiceNote(r.error ?? t('settings.voice.couldNotSave'));
    } catch (e) {
      setOpenAiVoiceNote(e instanceof Error ? e.message : String(e));
    }
  };
  // v0.3.4 fix: the config default is ON ('now on by default', 0.2.7) — seeding
  // with `?? false` displayed OFF while the feature was actually running.
  const [freeflowEnabled, setFreeflowEnabled] = useState(config.freeflowEnabled !== false);
  const [groqKey, setGroqKey] = useState(config.groqApiKey ?? '');
  const [freeflowModel, setFreeflowModel] = useState(config.freeflowModel ?? 'whisper-large-v3-turbo');
  const [showGroqKey, setShowGroqKey] = useState(false);
  const [freeflowBusy, setFreeflowBusy] = useState(false);
  const [freeflowNote, setFreeflowNote] = useState('');
  // rt-9 idle-tunable: realtime voice idle auto-disconnect window (ms); 0 = never.
  const [idleDisconnectMs, setIdleDisconnectMs] = useState<number>(
    (config as HarnessConfig).realtimeIdleDisconnectMs ?? 180_000
  );
  // Re-seed every editable field from the on-disk config when the modal opens.
  // App's `config` prop is loaded once and never refreshed after a save, so
  // without this the saved budget / velocity / slack values show blank on reopen.
  useEffect(() => {
    let alive = true;
    window.cth.getConfig().then((c) => {
      if (!alive) return;
      const cc = c as BreakerCfgView;
      setNotifications(cc.notifications === true);
      setAgentBudget(cc.costCapTokens != null ? String(cc.costCapTokens) : '');
      setVelocityCeiling(cc.circuitBreaker?.tokenVelocityPerMin != null ? String(cc.circuitBreaker.tokenVelocityPerMin) : '');
      setSlackEnabled(cc.slackEnabled ?? false);
      setSlackSecret(cc.slackSigningSecret ?? '');
      setSlackBotToken(cc.slackBotToken ?? '');
      setSlackChannel(cc.slackChannelId ?? '');
      setSlackPort(String(cc.slackPort ?? 3847));
      setSlackProactivePosting(cc.slackProactivePosting ?? false);
      const kgOn = (cc as { knowledgeGraph?: { enabled?: boolean } }).knowledgeGraph?.enabled === true;
      setKgEnabled(kgOn);
      setFreeflowEnabled(cc.freeflowEnabled !== false);
      setGroqKey(cc.groqApiKey ?? '');
      setFreeflowModel(cc.freeflowModel ?? 'whisper-large-v3-turbo');
      setIdleDisconnectMs((c as HarnessConfig).realtimeIdleDisconnectMs ?? 180_000);
    }).catch(() => { /* keep prop-seeded values */ });
    window.cth.kgStatus().then((s) => { if (alive) setKgDocCount(s.docCount); })
      .catch(() => { /* status unavailable */ });
    // Hydrate live connection state + the persisted Request URL: the
    // tunnel URL lives in main, so reopening Settings while connected re-shows it.
    window.cth.slackStatus().then((s) => {
      if (!alive) return;
      setRunning(s.running);
      if (s.url) setTunnelUrl(s.url);
    }).catch(() => { /* status unavailable - assume not running */ });
    // Triggers: re-read main and push the result into the shared mirror. App
    // already seeded it at launch; this catches anything the Triggers tab (or
    // another window) changed since, and is the ONLY place Settings reads them —
    // every render below comes off the store.
    void (async () => {
      try {
        const list = await triggersApi().listWebhooks();
        if (alive && Array.isArray(list)) useStore.getState().setWebhookTriggers(list);
      } catch { /* keep the mirror App seeded from getConfig() */ }
      try {
        const org = await triggersApi().getOrgTrigger();
        if (alive && org) useStore.getState().setOrgTrigger(org);
      } catch { /* ditto */ }
      try {
        const s = await triggersApi().webhooksStatus();
        if (!alive) return;
        setWebhookRunning(s.running);
        if (s.url) setWebhookUrl(s.url);
      } catch { /* status unavailable - assume not listening */ }
    })();
    return () => { alive = false; };
  }, []);
  /** Persist the current Slack inputs. Returns the resolved config patch. */
  const slackPatch = (enabled: boolean) => ({
    signingSecret: slackSecret,
    botToken: slackBotToken,
    channelId: slackChannel,
    port: Number(slackPort) || 3847,
    enabled,
    proactivePosting: slackProactivePosting
  });
  const saveSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try {
      await window.cth.slackSetConfig(slackPatch(slackEnabled));
      setSlackNote('saved');
    } catch (e) {
      setSlackNote(e instanceof Error ? e.message : String(e));
    } finally { setSlackBusy(false); }
  };
  const startSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try {
      // Persist first so the server starts with the latest secret/port/channel.
      await window.cth.slackSetConfig(slackPatch(true));
      setSlackEnabled(true);
      const res = await window.cth.slackStart();
      if (res.ok) {
        setRunning(true);
        // Keep the last URL if this start returned none (tunnel hiccup) - don't blank it.
        if (res.url) setTunnelUrl(res.url);
        setSlackNote(res.url ? 'listening' : (res.error ?? 'started, but tunnel unavailable'));
      } else {
        setSlackNote(res.error ?? 'failed to start');
      }
    } catch (e) {
      setSlackNote(e instanceof Error ? e.message : String(e));
    } finally { setSlackBusy(false); }
  };
  const stopSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    // Keep the last Request URL visible (greyed) after Stop.
    // Mirror startSlack: main persists slackEnabled:false, this keeps the pill
    // honest without waiting for a Settings reopen.
    try { await window.cth.slackStop(); setRunning(false); setSlackEnabled(false); setSlackNote('stopped'); }
    catch (e) { setSlackNote(e instanceof Error ? e.message : String(e)); }
    finally { setSlackBusy(false); }
  };
  // --- Webhook trigger handlers ---
  /** The one write path. Updates the shared mirror FIRST so the Triggers tab
   *  repaints immediately, then persists. Pass `persist: false` for keystroke
   *  edits (a rename) — the blur commits them. */
  const applyWebhooks = async (list: WebhookTrigger[], persist = true) => {
    setWebhookTriggersStore(list);
    if (!persist) return;
    setWebhookBusy(true); setWebhookNote('');
    try {
      const res = await triggersApi().saveWebhooks(list);
      if (res && res.ok === false) { setWebhookNote(res.error ?? 'could not save'); return; }
      setWebhookNote('saved');
      setTimeout(() => setWebhookNote(''), 1500);
    } catch (e) {
      setWebhookNote(e instanceof Error ? e.message : String(e));
    } finally { setWebhookBusy(false); }
  };
  /** Replace one entry by id (the shape every per-row control uses). */
  const patchWebhook = (id: string, patch: Partial<WebhookTrigger>, persist = true) =>
    applyWebhooks(webhookTriggers.map((w) => (w.id === id ? { ...w, ...patch } : w)), persist);
  /** New endpoint: main mints the secret (256-bit), and it ships DISABLED —
   *  turning on a public surface is always an explicit second click. */
  const addWebhook = async () => {
    setWebhookBusy(true); setWebhookNote('');
    let secret = '';
    try {
      const res = await triggersApi().generateWebhookSecret();
      secret = res.ok && res.secret ? res.secret : '';
    } catch (e) {
      setWebhookNote(e instanceof Error ? e.message : String(e));
    } finally { setWebhookBusy(false); }
    if (!secret) { setWebhookNote('could not generate a secret'); return; }
    const entry: WebhookTrigger = {
      id: newWebhookId(),
      name: `Webhook ${webhookTriggers.length + 1}`,
      secret,
      enabled: false,
      mode: DEFAULT_TRIGGER_MODE,
      schema: DEFAULT_WEBHOOK_SCHEMA,
      createdAt: Date.now()
    };
    setShownSecrets((s) => ({ ...s, [entry.id]: true })); // show it once, to copy
    await applyWebhooks([...webhookTriggers, entry]);
  };
  /** Mint a fresh secret for ONE endpoint. The old one stops working at once —
   *  that is the point, and it never disturbs the other webhooks. */
  const rotateWebhookSecret = async (id: string) => {
    setWebhookBusy(true); setWebhookNote('');
    let secret = '';
    try {
      const res = await triggersApi().generateWebhookSecret();
      secret = res.ok && res.secret ? res.secret : '';
    } catch (e) {
      setWebhookNote(e instanceof Error ? e.message : String(e));
    } finally { setWebhookBusy(false); }
    if (!secret) { setWebhookNote('could not generate a secret'); return; }
    setShownSecrets((s) => ({ ...s, [id]: true }));
    await patchWebhook(id, { secret });
    setWebhookNote('new secret — copy it now');
  };
  const removeWebhook = async (id: string) => {
    setPendingDelete(null);
    setWebhookBusy(true); setWebhookNote('');
    try {
      await triggersApi().deleteWebhook(id);
      setWebhookNote('deleted');
      setTimeout(() => setWebhookNote(''), 1500);
    } catch (e) {
      setWebhookNote(e instanceof Error ? e.message : String(e));
    } finally { setWebhookBusy(false); }
    // Mirror the removal either way: if main rejected it, the next open re-reads.
    setWebhookTriggersStore(webhookTriggers.filter((w) => w.id !== id));
  };
  /** Endpoint URL for one webhook: every entry shares the tunnel, the id picks it. */
  const webhookEndpoint = (id: string) => (webhookUrl ? `${webhookUrl.replace(/\/$/, '')}/${id}` : '');
  const copyTunnel = () => { void window.cth.copyToClipboard(tunnelUrl); };
  // --- Organisation trigger handlers ---
  /** Same contract as webhooks: mirror first (so the Triggers tab is live), then
   *  persist. Keystroke edits pass `persist: false` and commit on blur. */
  const applyOrg = async (next: OrgTriggerConfig, persist = true) => {
    setOrgTriggerStore(next);
    if (!persist) return;
    setOrgBusy(true); setOrgNote('');
    try {
      const res = await triggersApi().setOrgTrigger(next);
      if (res && res.ok === false) { setOrgNote(res.error ?? 'could not save'); return; }
      setOrgNote('saved');
      setTimeout(() => setOrgNote(''), 1500);
    } catch (e) {
      setOrgNote(e instanceof Error ? e.message : String(e));
    } finally { setOrgBusy(false); }
  };
  // --- Free Flow handlers ---
  /** Persist Free Flow settings; main re-arms the global hotkey. Also mirror the
   *  flag into the store so the composer mic button appears/disappears live. */
  const saveFreeflow = async (enabledOverride?: boolean) => {
    const enabled = enabledOverride ?? freeflowEnabled;
    setFreeflowBusy(true); setFreeflowNote('');
    try {
      await window.cth.freeflowSetConfig({
        enabled,
        apiKey: groqKey,
        model: freeflowModel.trim() || 'whisper-large-v3-turbo'
      });
      setFreeflowEnabledStore(enabled);
      // Mirror boolean key-presence so the voice button enables/disables live
      // without an app restart (presence only — never the key value).
      setHasGroqKeyStore(!!groqKey.trim());
      setFreeflowNote('saved');
    } catch (e) {
      setFreeflowNote(e instanceof Error ? e.message : String(e));
    } finally { setFreeflowBusy(false); }
  };
  /** Toggle on/off and persist immediately so the change takes effect (and the
   *  global hotkey arms/disarms) without a separate Save click. */
  const toggleFreeflow = () => {
    const next = !freeflowEnabled;
    setFreeflowEnabled(next);
    void saveFreeflow(next);
  };
  const reset = async () => {
    setBusy(true);
    clearLocalState();
    // Wipes hive + palace, resets config, and relaunches into onboarding.
    // The app exits, so this never resolves - no need to clear `busy`.
    await window.cth.resetAll();
  };
  // --- Change home folder ---
  /** Pick a new folder, then open the move-vs-fresh sub-modal. */
  const pickNewHome = async () => {
    setChangeErr('');
    const res = await window.cth.chooseFolder();
    if (!res.ok) return; // cancelled - no-op
    setChangeMode('move'); // recommended default
    setChangeHome(res.path);
  };
  /** Apply the home-folder change. On success the app relaunches (never resolves);
   *  on failure we surface the error and the existing home keeps running. */
  const applyChangeHome = async () => {
    if (!changeHome) return;
    setChangeBusy(true); setChangeErr('');
    // Moving copies the hive (incl. its .git) + palace, so the new home owns the
    // same renderer-side roster - keep localStorage. A 'fresh' home starts empty,
    // so clear the renderer cache to match.
    if (changeMode === 'fresh') clearLocalState();
    try {
      const res = await window.cth.changeHome(changeHome, changeMode);
      if (!res.ok) { setChangeErr(res.error ?? 'Could not change the home folder.'); setChangeBusy(false); }
      // ok === true never returns (the process relaunches).
    } catch (e) {
      setChangeErr(e instanceof Error ? e.message : String(e));
      setChangeBusy(false);
    }
  };
  const modalTitle = changeHome
    ? t('settings.changeHomeTitle')
    : confirming
      ? t('settings.resetTitle')
      : t('settings.title');

  return {
    config, onClose, initialSection,
    t,
    i18n,
    godName,
    confirming,
    setConfirming,
    busy,
    setBusy,
    activeSection,
    setActiveSection,
    changeHome,
    setChangeHome,
    changeMode,
    setChangeMode,
    changeBusy,
    setChangeBusy,
    changeErr,
    setChangeErr,
    notifications,
    setNotifications,
    toggleNotifications,
    cfgX,
    pending,
    setPending,
    autoCompactPending,
    setAutoCompactPending,
    saveBusy,
    setSaveBusy,
    saveNote,
    setSaveNote,
    dirty,
    stage,
    keepAwake,
    setKeepAwake,
    toggleKeepAwake,
    simpleMode,
    setSimpleMode,
    arabicTerminal,
    setArabicTerminal,
    arabicFollowsLanguage,
    setArabicFollowsLanguage,
    toggleSimpleMode,
    autoModeOn,
    setAutoModeOn,
    toggleAutoMode,
    orchSpawnOn,
    setOrchSpawnOn,
    toggleOrchSpawn,
    defaultModelSel,
    setDefaultModelSel,
    saveDefaultModel,
    maxTurnsVal,
    setMaxTurnsVal,
    maxTurnsPatch,
    semMemOn,
    setSemMemOn,
    toggleSemMem,
    breakerCfg,
    agentBudget,
    setAgentBudget,
    velocityCeiling,
    setVelocityCeiling,
    brkEnabled,
    setBrkEnabled,
    brkHardStop,
    setBrkHardStop,
    brkRepeated,
    setBrkRepeated,
    brkErrStorm,
    setBrkErrStorm,
    budgetPatch,
    saveAll,
    requestClose,
    fmtBudgetTokens,
    slackEnabled,
    setSlackEnabled,
    slackSecret,
    setSlackSecret,
    slackBotToken,
    setSlackBotToken,
    slackChannel,
    setSlackChannel,
    slackPort,
    setSlackPort,
    slackProactivePosting,
    setSlackProactivePosting,
    tunnelUrl,
    setTunnelUrl,
    slackBusy,
    setSlackBusy,
    slackNote,
    setSlackNote,
    running,
    setRunning,
    showSlackHelp,
    setShowSlackHelp,
    webhookTriggers,
    setWebhookTriggersStore,
    webhookUrl,
    setWebhookUrl,
    webhookRunning,
    setWebhookRunning,
    webhookBusy,
    setWebhookBusy,
    webhookNote,
    setWebhookNote,
    shownSecrets,
    setShownSecrets,
    pendingDelete,
    setPendingDelete,
    showWebhookHelp,
    setShowWebhookHelp,
    orgTrigger,
    setOrgTriggerStore,
    showOrgKey,
    setShowOrgKey,
    orgBusy,
    setOrgBusy,
    orgNote,
    setOrgNote,
    kgEnabled,
    setKgEnabled,
    kgDocCount,
    setKgDocCount,
    kgBusy,
    setKgBusy,
    kgNote,
    setKgNote,
    refreshKgStatus,
    toggleKg,
    addKgFiles,
    autoCompactOn,
    setAutoCompactOn,
    toggleAutoCompact,
    autoUpdateOn,
    setAutoUpdateOn,
    toggleAutoUpdate,
    telemetryOn,
    setTelemetryOn,
    toggleTelemetry,
    setFreeflowEnabledStore,
    setHasGroqKeyStore,
    hasOpenAiKey,
    setHasOpenAiKey,
    openAiVoiceKey,
    setOpenAiVoiceKey,
    openAiVoiceNote,
    setOpenAiVoiceNote,
    saveOpenAiVoiceKey,
    freeflowEnabled,
    setFreeflowEnabled,
    groqKey,
    setGroqKey,
    freeflowModel,
    setFreeflowModel,
    showGroqKey,
    setShowGroqKey,
    freeflowBusy,
    setFreeflowBusy,
    freeflowNote,
    setFreeflowNote,
    idleDisconnectMs,
    setIdleDisconnectMs,
    slackPatch,
    saveSlack,
    startSlack,
    stopSlack,
    applyWebhooks,
    patchWebhook,
    addWebhook,
    rotateWebhookSecret,
    removeWebhook,
    webhookEndpoint,
    copyTunnel,
    applyOrg,
    saveFreeflow,
    toggleFreeflow,
    reset,
    pickNewHome,
    applyChangeHome,
    modalTitle
  };
}

export type SettingsState = ReturnType<typeof useSettingsState>;
