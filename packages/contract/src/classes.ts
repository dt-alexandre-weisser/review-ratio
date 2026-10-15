/**
 * Semantic file classes.
 *
 * A class never reveals the language of a file. The server publishes the globs that map a
 * path to a class; the weights of the classes stay on the server.
 */
export const FILE_CLASSES = [
  'production',
  'test',
  'config',
  'ci',
  'tooling',
  'docs',
  'generated',
  'chore',
] as const;

export type FileClass = (typeof FILE_CLASSES)[number];
