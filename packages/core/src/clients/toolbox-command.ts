export const TOOLBOX_NPX_COMMAND = 'npx';
export const TOOLBOX_NPX_PACKAGE = '@toolbox/cli';
export const TOOLBOX_LEGACY_NPX_PACKAGE = 'tlbx';
export const TOOLBOX_STDIO_ARGS = ['-y', TOOLBOX_NPX_PACKAGE, 'serve', '--stdio'] as const;
export const TOOLBOX_STDIO_COMMAND = [TOOLBOX_NPX_COMMAND, ...TOOLBOX_STDIO_ARGS] as const;
export const TOOLBOX_LEGACY_STDIO_ARGS = [
  '-y',
  TOOLBOX_LEGACY_NPX_PACKAGE,
  'serve',
  '--stdio',
] as const;
export const TOOLBOX_LEGACY_STDIO_COMMAND = [
  TOOLBOX_NPX_COMMAND,
  ...TOOLBOX_LEGACY_STDIO_ARGS,
] as const;
