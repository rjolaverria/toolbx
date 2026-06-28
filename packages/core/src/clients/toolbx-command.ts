export const TOOLBX_NPX_COMMAND = 'npx';
export const TOOLBX_NPX_PACKAGE = '@toolbx/cli';
export const TOOLBX_LEGACY_NPX_PACKAGE = 'tlbx';
export const TOOLBX_STDIO_ARGS = ['-y', TOOLBX_NPX_PACKAGE, 'serve', '--stdio'] as const;
export const TOOLBX_STDIO_COMMAND = [TOOLBX_NPX_COMMAND, ...TOOLBX_STDIO_ARGS] as const;
export const TOOLBX_LEGACY_STDIO_ARGS = [
  '-y',
  TOOLBX_LEGACY_NPX_PACKAGE,
  'serve',
  '--stdio',
] as const;
export const TOOLBX_LEGACY_STDIO_COMMAND = [
  TOOLBX_NPX_COMMAND,
  ...TOOLBX_LEGACY_STDIO_ARGS,
] as const;
