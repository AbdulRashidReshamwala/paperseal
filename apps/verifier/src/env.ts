import { resolveDefaults } from './runtime-config';

/*
 * This build and host's defaults, each a `VITE_` value, then `config.json`, then the built-in one
 * (spec/deploy.md, "App config.json"). Read once at import, after main.tsx has set the config.
 */
const defaults = resolveDefaults();

/**
 * The bucket the TEE was started with, which `env_override` must name. The page passes the viewer's
 * own setting instead, and an exam name's bucket record replaces that for one view. Unset, it is
 * empty and the claim fails against any real token.
 */
export const teeStorageBucket: string = defaults.storageBucket;

/**
 * This page's own release tag, such as `v1.2.3`, which the agent prompt names as its version
 * (spec/agent-verification.md, "Prompt"). Unset or malformed, the "Check with your own AI" button
 * is disabled and says why.
 */
export const releaseTag: string = defaults.releaseTag;

/** The Swarm API backups are read through, unless the viewer's settings name another. */
export const swarmApiUrl: string = defaults.swarmApiUrl;
