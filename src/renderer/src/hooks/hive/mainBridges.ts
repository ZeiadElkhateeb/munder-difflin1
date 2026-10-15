/**
 * Effects 5–5c: events pushed from main — Slack ingress, degraded spawns, main-initiated
 * roster changes (voice hires/kills), and voice-staged queue insertions.
 */
import { useEffect } from 'react';
import { useStore, type Agent } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { OFFICE_CAST, DEFAULT_CHARACTER } from '@/scene/office/cast';
import { GOD_ID, SPAWN_ACCENTS } from './shared';
import type { HiveContext } from './context';

export function useMainBridges(config: HarnessConfig | null, ctx: HiveContext): void {
  // 5) Pipe inbound Slack messages into Michael's queue. The main-process Slack
  //    webhook server pushes each verified message here via IPC; enqueueing to
  //    GOD_ID lands it in Michael's queue exactly as if the user had typed it
  //    into the composer — effect #4 above then drains it to his PTY.
  //    We immediately ack in the triggering thread and stash the thread coords
  //    so the office can post its summary back later.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onSlackMessage((msg) => {
      const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
      if (!msg?.text?.trim() && !hasFiles) return;
      let text = msg.text.trim();
      // Append local file paths so the agent (Claude Code) can Read them directly.
      if (hasFiles) {
        const fileLines = msg.files!.map((f) => `- ${f.path} (${f.name})`).join('\n');
        text = text ? `${text}\n\nAttached files:\n${fileLines}` : `Attached files:\n${fileLines}`;
      }
      const slack = { channel: msg.channel, thread_ts: msg.thread_ts };
      // `text` (raw user request + any attachment lines) drives the human-facing
      // kanban card title/description. The autonomy preamble — supplied verbatim
      // by main, the authoritative source — is prepended ONLY to god's working
      // instruction (what gets typed into his PTY), so the board stays readable
      // while every Slack-origin god-session runs under the autonomy policy. When
      // main sends no preamble (older build), god just gets the raw text.
      const instruction = msg.autonomyPreamble ? `${msg.autonomyPreamble}${text}` : undefined;
      useStore.getState().enqueueMessage(GOD_ID, text, { slack, instruction });
      // Immediate "queued" acknowledgement in the originating Slack thread.
      void window.cth.slackReply({
        channel: msg.channel,
        thread_ts: msg.thread_ts,
        text: ':hourglass_flowing_sand: *Received.* Your request has been queued — the team is on it and will reply here when done.'
      });
    });
  }, [config?.onboardingComplete]);
  // 5b) An agent that spawned without hive events (proxy bridge never bound) gets
  //     no live status from hooks, so its card's action line would otherwise sit
  //     on whatever it last said. Put the reason there instead; nothing from the
  //     event plane will overwrite it for this session. (Main also raises a native
  //     notification when notifications are on.)
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onHiveDegraded?.((evt) => {
      if (!evt?.agentId) return;
      useStore.getState().updateAgent(evt.agentId, {
        action: '⚠ running without hive events: respawn to retry'
      });
    });
  }, [config?.onboardingComplete]);
  // 5b) MAIN-initiated roster changes (rt-5 voice spawn/kill). The renderer store is
  //     only mutated by renderer-initiated hires (AddAgentModal); a voice hire/kill
  //     runs in MAIN (spawnAgentCore / teardownPty, owner=null) and would otherwise
  //     be invisible on the floor. Main broadcasts; we build/archive the card here.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const offSpawn = window.cth.onHiveAgentSpawned?.((rec) => {
      if (!rec?.id) return;
      // addAgent is idempotent, but bail early if the renderer already carded it.
      if (useStore.getState().agents.some((a) => a.id === rec.id)) return;
      // An explicit character wins; otherwise infer it from the name, which is
      // what makes "spawn one called Meredith" land on the Meredith avatar with
      // nothing else asked for. The explicit field covers what inference cannot
      // express: an agent named something else that should still look like a
      // particular character. Unknown values fall through to the inference rather
      // than breaking the card.
      const castMember = (q?: string) =>
        q ? OFFICE_CAST.find((m) => m.name === q || m.displayName.toLowerCase() === q)?.name : undefined;
      const character =
        castMember(rec.character?.trim().toLowerCase()) ??
        castMember((rec.name || rec.id).toLowerCase()) ??
        DEFAULT_CHARACTER;
      // Accent is otherwise hashed from the worker id, which is stable but not
      // choosable. An unrecognised accent keeps the hash.
      const askedAccent = SPAWN_ACCENTS.find((a) => a === rec.accent?.trim().toLowerCase());
      let h = 0;
      for (const ch of rec.id) h = (h + ch.charCodeAt(0)) % SPAWN_ACCENTS.length;
      const project = (rec.cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'hive';
      const agent: Agent = {
        id: rec.id,
        name: rec.name || rec.id,
        character,
        accent: askedAccent ?? SPAWN_ACCENTS[h],
        description: rec.role || 'a fresh harness',
        project,
        tmuxTarget: '',
        cwd: rec.cwd,
        status: 'idle',
        action: 'starting up',
        progress: 0,
        currentStation: 'desk',
        ptyId: rec.id,
        command: rec.command,
        provider: rec.provider as Agent['provider'],
        isGod: false,
        recentTextTs: Date.now()
      };
      useStore.getState().addAgent(agent);
    });
    const offArchive = window.cth.onHiveAgentArchived?.((e) => {
      if (e?.id) useStore.getState().archiveAgent(e.id);
    });
    return () => { offSpawn?.(); offArchive?.(); };
  }, [config?.onboardingComplete]);
  // 5c) v0.3.4 voice bridge: main stages queue insertions (clear_context) and
  //     pushes them here, so delivery rides EVERY existing gate — idle-only,
  //     boot grace, draft/picker safety, auto-delivery pause. Main owns the
  //     confirm policy; this is just the enqueue.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onRealtimeEnqueue?.((evt) => {
      if (!evt?.agentId || typeof evt.text !== 'string' || !evt.text.trim()) return;
      const { agents, enqueueMessage } = useStore.getState();
      if (!agents.some((a) => a.id === evt.agentId)) return;
      enqueueMessage(evt.agentId, evt.text.trim());
    });
  }, [config?.onboardingComplete]);
}
