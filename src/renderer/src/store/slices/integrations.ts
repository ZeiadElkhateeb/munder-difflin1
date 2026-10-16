/**
 * Integration flags mirrored from config/main: Free Flow, provider-key presence, webhook
 * triggers and the org trigger.
 */
import type { StateCreator } from 'zustand';
import { DEFAULT_ORG_TRIGGER, type OrgTriggerConfig, type WebhookTrigger } from '@shared/triggers';
import type { State } from '../store';

export interface IntegrationsSlice {
  /** Mirror of config.freeflowEnabled so the composer can show/hide the Free Flow
   *  mic button reactively (set by App on config load and by Settings on save). */
  freeflowEnabled: boolean;
  setFreeflowEnabled: (on: boolean) => void;
  /** Mirror of `!!config.groqApiKey` — boolean presence ONLY; the key value never
   *  enters the store. Lets the composer show the voice button disabled (with a
   *  "add a Groq key" tooltip) instead of hiding it. Set by App on config load and
   *  by Settings on save. */
  hasGroqKey: boolean;
  setHasGroqKey: (has: boolean) => void;
  /** Mirror of BYOK OpenAI key presence (boolean only — the key lives in the main
   *  secret broker, never the store). Gates the Realtime Michael voice toggle the
   *  way hasGroqKey gates the Free Flow mic. Set by App on load via
   *  window.cth.realtimeHasOpenAiKey(). */
  hasOpenAiKey: boolean;
  setHasOpenAiKey: (has: boolean) => void;
  /** Mirror of config.webhookTriggers — the inbound HTTP endpoints. Webhooks are
   *  editable from BOTH Settings → Connections and the Triggers tab, so neither
   *  surface keeps its own copy: both render off this list and both call the
   *  setter after persisting, and the other one repaints without a refetch.
   *  Seeded by App from getConfig() (main deep-fills the field on every read).
   *
   *  Holds per-endpoint secrets, because a secret is what the UI has to show for
   *  reveal/copy to mean anything. Renderer memory only — never persisted to
   *  localStorage or the roster file, never logged, masked in every surface. */
  webhookTriggers: WebhookTrigger[];
  setWebhookTriggers: (list: WebhookTrigger[]) => void;
  /** Mirror of config.orgTrigger (peer messaging between teammates' clone nodes).
   *  Same two-way contract as `webhookTriggers`, and the same handling for
   *  `apiKey` — in memory for the two surfaces that display it masked, nowhere
   *  else. Configuration only for now: no transport reads the key yet. */
  orgTrigger: OrgTriggerConfig;
  setOrgTrigger: (cfg: OrgTriggerConfig) => void;
}

export const createIntegrationsSlice: StateCreator<State, [], [], IntegrationsSlice> = (set, get) => ({
  freeflowEnabled: false,
  setFreeflowEnabled: (on) => set({ freeflowEnabled: on }),
  hasGroqKey: false,
  setHasGroqKey: (has) => set({ hasGroqKey: has }),
  hasOpenAiKey: false,
  setHasOpenAiKey: (has) => set({ hasOpenAiKey: has }),
  webhookTriggers: [],
  setWebhookTriggers: (list) => set({ webhookTriggers: list }),
  // A copy, not the shared DEFAULT_ORG_TRIGGER instance — main takes the same
  // care (withTriggerDefaults), and handing the module-level default out is how
  // one careless mutation rewrites the default for everyone.
  orgTrigger: { ...DEFAULT_ORG_TRIGGER },
  setOrgTrigger: (cfg) => set({ orgTrigger: cfg })
});
