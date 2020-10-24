import { makePluginByCombiningPlugins } from 'postgraphile';
import { ReplaceTypeWithPatchPlugin } from './ReplaceTypeWithPatchPlugin';
import { ResolvePatchFieldsPlugin } from './ResolvePatchFieldsPlugin';

export default makePluginByCombiningPlugins(
  ReplaceTypeWithPatchPlugin,
  ResolvePatchFieldsPlugin
);
