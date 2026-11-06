/** The repository the apps link to and read releases from, unless VITE_RELEASES_REPO names a fork. Plain, so vite.config.ts can import it. */
export const defaultRepository = 'AbdulRashidReshamwala/paperseal';

/** `owner/name`, as spec/agent-verification.md "Prompt" requires. */
export const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
