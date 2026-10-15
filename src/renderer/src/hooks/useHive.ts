import type { HarnessConfig } from '@/store/config';
import { useHiveContext } from './hive/context';
import { useGodBootstrap } from './hive/godBootstrap';
import { useHookFeeds } from './hive/hookFeeds';
import { useMessageDelivery } from './hive/messageDelivery';
import { useMainBridges } from './hive/mainBridges';
import { useContextTriggers } from './hive/contextTriggers';
import { useAutoRevive } from './hive/autoRevive';

/**
 * The renderer-side glue for the hive:
 *   1. spawns the god agent into Michael's room when none is running,
 *   2. drives avatar state from real Claude Code hook events, and
 *   3. wakes idle agents that have unread inbox messages so collaboration
 *      doesn't stall while an agent sits at its prompt.
 */
export function useHive(config: HarnessConfig | null): void {
  const ctx = useHiveContext();
  // Order matters: React runs effects in declaration order, and these hooks keep
  // the order the effects had when they all lived in this one function.
  useGodBootstrap(config, ctx);
  useHookFeeds(config, ctx);
  useMessageDelivery(config, ctx);
  useMainBridges(config, ctx);
  useContextTriggers(config, ctx);
  useAutoRevive(config, ctx);
}
