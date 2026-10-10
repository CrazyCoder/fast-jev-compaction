/**
 * The plugin's name, in one place: the id Claude Code knows it by (and the
 * recall tool's server name), the data folder, and the prefix of every marker
 * it writes into a conversation.
 */

/** The plugin id: `plugin.json`'s name, the data folder under the config dir, the log prefix. */
export const PLUGIN_ID = 'jetcompact';

/** `[<id> <rest>]`: a marker this plugin writes into a conversation. */
export const marker = (rest: string): string => `[${PLUGIN_ID} ${rest}]`;

/** `[<id>: <rest>]`: a placeholder this plugin writes in place of content. */
export const placeholder = (rest: string): string => `[${PLUGIN_ID}: ${rest}]`;
